const fs = require("fs");
const https = require("https");
const Booru = require("booru");
const {login} = require("masto");

const config = require("./config.json");

// Load or create the history file
const loadHistory = () => {
  try {
    if (fs.existsSync(config.history.file)) {
      return JSON.parse(fs.readFileSync(config.history.file, 'utf8'));
    }
    return [];
  } catch (err) {
    console.error("Error loading history file:", err.message);
    return [];
  }
};

// Save the history file
const saveHistory = (history) => {
  try {
    fs.writeFileSync(config.history.file, JSON.stringify(history));
  } catch (err) {
    console.error("Error saving history file:", err.message);
  }
};

// Find a new, non-duplicate image
const findNewImage = async (postedHistory) => {
  const b = Booru.forSite(config.booru.name);
  let attempts = 0;

  while (attempts < config.history.retries) {
    try {
      const res = await b.search(config.booru.tags, {limit: 1, random: true});
      const img = res[0];
      
      // Check if this image has been posted recently
      if (!postedHistory.includes(img.id)) {
        return img;
      }
      
      attempts++;
      console.log(`Duplicate image found, attempt ${attempts}/${config.history.retries}`);
    } catch (err) {
      console.error("Error searching for image:", err.message);
      throw err;
    }
  }
  
  throw new Error("Could not find a non-duplicate image after multiple attempts");
};

(async () => {
  let postedHistory = loadHistory();
  let img;
  let tempFile;

  try {
    if (!fs.existsSync("./tmp")) {
      fs.mkdirSync("./tmp");
    }

    // Find a new, non-duplicate image
    img = await findNewImage(postedHistory);
    
    // Update history
    postedHistory.unshift(img.id);
    if (postedHistory.length > config.history.limit) {
      postedHistory = postedHistory.slice(0, config.history.limit);
    }
    saveHistory(postedHistory);

    // Download and post the image
    tempFile = `./tmp/${img.data.image}`;
    https.get(img.sampleUrl || img.fileUrl, res => res.pipe(fs.createWriteStream(tempFile)).on("finish", async () => {
      let client;
      try {
        client = await login({
          url: config.mastodon.url,
          accessToken: config.mastodon.token
        });
      } catch (ex) {
        console.error("Error logging into Mastodon:", ex.message);
        return;
      }

      let attachment;
      try {
        attachment = await client.mediaAttachments.create({
          file: fs.createReadStream(tempFile),
          description: `${img.postView}`
        });
      } catch (ex) {
        console.error("Error uploading attachment:", ex.message);
        return;
      }

      try {
        await client.statuses.create({
          status: `${img.postView}\n\n${config.mastodon.tags.map(tag => `#${tag.replace(/^#/, "")}`).join(" ")}`,
          visibility: "public",
          mediaIds: [attachment.id]
        });
        console.log("Successfully posted new image:", img.id);
      } catch (ex) {
        console.error("Error posting to Mastodon:", ex.message);
      }

      try {
        fs.unlink(tempFile, (err) => {
          if (err) console.error("Error deleting temp file:", err.message);
        });
      } catch (ex) {
        console.error("Error cleaning up:", ex.message);
      }
    }));
  } catch (ex) {
    console.error("Error in main process:", ex.message);
  }
})();
