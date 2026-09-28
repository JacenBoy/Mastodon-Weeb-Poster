const fs = require("fs");
const https = require("https");
const Booru = require("booru");
const {createRestAPIClient} = require("masto");

const config = require("./config.json");

const wait = require("util").promisify(setTimeout);

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

// Retry an async operation, waiting between failed attempts
const withRetries = async (label, fn) => {
  for (let attempt = 1; attempt <= config.history.retries; attempt++) {
    try {
      return await fn();
    } catch (ex) {
      console.error(`${label} failed, attempt ${attempt}/${config.history.retries}:`, ex.message);
      if (attempt < config.history.retries) await wait(5000);
    }
  }
  throw new Error(`${label} failed after ${config.history.retries} attempts`);
};

// Download a file to disk
const download = (url, dest) => new Promise((resolve, reject) => {
  https.get(url, res => {
    if (res.statusCode !== 200) {
      res.resume();
      return reject(new Error(`Download failed with status ${res.statusCode}`));
    }
    res.pipe(fs.createWriteStream(dest))
      .on("finish", resolve)
      .on("error", reject);
  }).on("error", reject);
});

(async () => {
  let postedHistory = loadHistory();
  let tempFile;

  try {
    if (!fs.existsSync("./tmp")) {
      fs.mkdirSync("./tmp");
    }

    // Find a new, non-duplicate image
    const img = await findNewImage(postedHistory);

    // Download the image
    tempFile = `./tmp/${img.data.image}`;
    await download(img.sampleUrl || img.fileUrl, tempFile);

    const client = createRestAPIClient({
      url: config.mastodon.url,
      accessToken: config.mastodon.token
    });

    const attachment = await withRetries("Uploading attachment", async () => client.v2.media.create({
      file: await fs.openAsBlob(tempFile),
      description: `${img.postView}`
    }));

    // The idempotency key stops Mastodon from creating a duplicate status if a
    // retry follows a request that succeeded but whose response was lost
    await withRetries("Posting to Mastodon", () => client.v1.statuses.create({
      status: `${img.postView}

${config.mastodon.tags.map(tag => `#${tag.replace(/^#/, "")}`).join(" ")}`,
      visibility: "public",
      mediaIds: [attachment.id]
    }, {
      requestInit: {headers: {"Idempotency-Key": `weeb-poster-${img.id}`}}
    }));
    console.log("Successfully posted new image:", img.id);

    // Update history only once the image has actually been posted
    postedHistory.unshift(img.id);
    if (postedHistory.length > config.history.limit) {
      postedHistory = postedHistory.slice(0, config.history.limit);
    }
    saveHistory(postedHistory);
  } catch (ex) {
    console.error("Error in main process:", ex.message);
    process.exitCode = 1;
  } finally {
    if (tempFile) {
      fs.unlink(tempFile, (err) => {
        if (err && err.code !== "ENOENT") console.error("Error deleting temp file:", err.message);
      });
    }
  }
})();
