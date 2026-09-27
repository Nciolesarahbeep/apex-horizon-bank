// Query-string reader built on the WHATWG URL API.
//
// Vercel's `req.query` helper parses the URL with Node's legacy `url.parse()`,
// which Node 24 flags with a DEP0169 deprecation warning in the logs every time
// a function reads `req.query`. Reading the query this way avoids that.
function getQuery(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const query = {};
    for (const [key, value] of url.searchParams) {
      if (key in query) {
        query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
      } else {
        query[key] = value;
      }
    }
    return query;
  } catch (err) {
    return {};
  }
}

module.exports = { getQuery };
