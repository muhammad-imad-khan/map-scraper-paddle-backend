// Minimal entrypoint for Vercel build. All routes are handled by api/ serverless functions.
module.exports = (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Map Scraper API — use /api/* endpoints' });
};
