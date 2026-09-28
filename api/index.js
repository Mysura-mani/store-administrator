// Vercel's convention: any file under /api is a serverless function. This
// one re-exports the whole Express app (backend/server.js already exports
// it instead of calling app.listen() when required as a module), and
// vercel.json rewrites every request to it, so the same app that runs
// locally via `npm start` also runs unchanged as a single serverless
// function in production.
module.exports = require("../backend/server.js");
