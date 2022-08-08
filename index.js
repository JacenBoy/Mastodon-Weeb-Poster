const fs = require("fs");
const https = require("https");
const Booru = require("booru");
const {login} = require("masto");

const config = require("./config.json");

(async () => {
  let img;
  let tempFile;
  try {
    const b = Booru.forSite(config.booru.name);
    const res = await b.search(config.booru.tags, {limit: 1, random: true});
    img = res[0];
    tempFile = `./tmp/${img.data.image}`;
    https.get(img.sampleUrl || img.fileUrl, res => res.pipe(fs.createWriteStream(tempFile)).on("finish", async () => {
      let client;
      try {
        client = await login({
          url: config.mastodon.url,
          accessToken: config.mastodon.token
        });
      } catch (ex) {
        console.error("Error logging into Mastodon: " + ex.message);
      }

      let attachment;
      try {
        attachment = await client.mediaAttachments.create({
          file: fs.createReadStream(tempFile),
          description: `${img.postView}`
        });
      } catch (ex) {
        console.error("Error uploading attachment: " + ex.message);
      }

      try {
        const status = await client.statuses.create({
          status: `${img.postView}`,
          visibility: "public",
          mediaIds: [attachment.id]
        });
      } catch (ex) {
        console.error("Error posting to Mastodon: " + ex.message);
      }

      try {
        fs.unlink(tempFile, (err) => {});
      } catch (ex) {
        console.error(ex.message);
      }
    }));
  } catch (ex) {
    console.error("Error getting image from booru: " + ex.message);
  }
})();