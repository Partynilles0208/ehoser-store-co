// Local QA only. Not imported by either production entry point. No real accounts.
const express = require('express');
const path = require('path');
const { mountEarthDrive } = require('../../lib/earthdrive');
const app = express();
const fixtureMode = process.argv.includes('--fixtures');
app.get('/qa/:plan', (req, res) => {
  const token = req.params.plan === 'pro' ? 'local-qa-pro' : req.params.plan === 'free' ? 'local-qa-free' : '';
  res.type('html').send(`<script>localStorage.setItem('token',${JSON.stringify(token)});location.replace('/earthdrive/')</script>`);
});
const fetchImpl = fixtureMode ? async (url, init) => {
  if (String(url).includes('photon')) return Response.json({ features: [{ properties: { name: 'Berlin · QA', country: 'Deutschland' }, geometry: { coordinates: [13.3782, 52.5161] } }] });
  const match = new URLSearchParams(init.body).get('data').match(/around:1000,([\d.-]+),([\d.-]+)/);
  const lat = Number(match[1]), lon = Number(match[2]);
  const point = (x, y) => ({ lat: lat+y/111320, lon: lon+x/(111320*Math.cos(lat*Math.PI/180)) });
  const elements = [];
  for(let i=-3;i<=3;i++) {
    elements.push({ type:'way',id:100+i,tags:{highway:'residential',name:'QA-Allee'},geometry:[point(-600,i*90),point(600,i*90)] });
    elements.push({ type:'way',id:200+i,tags:{highway:'residential',name:'QA-Straße'},geometry:[point(i*90,-600),point(i*90,600)] });
    for(let j=-3;j<=3;j++) elements.push({type:'way',id:500+(i+3)*7+j+3,tags:{building:'yes',height:String(8+((i+j+6)%4)*6)},geometry:[point(i*90+18,j*90+18),point(i*90+65,j*90+18),point(i*90+65,j*90+65),point(i*90+18,j*90+65),point(i*90+18,j*90+18)]});
  }
  return Response.json({ elements });
} : fetch;
mountEarthDrive(app, {
  env: {}, fetchImpl,
  readAuthUser: (req,res) => {
    const token = (req.headers.authorization || '').slice(7);
    if (!['local-qa-pro','local-qa-free'].includes(token)) { res.status(401).json({error:'Bitte anmelden.'}); return null; }
    return {username:token};
  },
  getProfile: async username => ({isPro:username==='local-qa-pro',proUntil:new Date(Date.now()+3600000).toISOString()})
});
app.use(express.static(path.join(__dirname,'../../public')));
app.listen(4173, '0.0.0.0', () => console.log(`EarthDrive QA on http://localhost:4173/qa/pro (${fixtureMode?'synthetic fixtures':'live OSM data'})`));
