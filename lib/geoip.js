async function lookupGeo(ip) {
  try {
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { city: 'Local', region: '', country: 'Local' };
    }
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await response.json();
    if (data.status !== 'success') return { city: null, region: null, country: null };
    return { city: data.city, region: data.regionName, country: data.country };
  } catch (err) {
    console.error('Geo lookup error:', err);
    return { city: null, region: null, country: null };
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

module.exports = { lookupGeo, getClientIp };
