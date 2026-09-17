import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrate, circleHitsPolygon, carHits, findSpawn, localPoint, geoPoint, distance } from '../../public/earthdrive/physics.mjs';
import { parseWorld } from '../../public/earthdrive/world.mjs';
const box = (x1,y1,x2,y2) => ({ outer: [{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2}], holes: [], bounds: { minX:x1,minY:y1,maxX:x2,maxY:y2 } });
const state = () => ({ x:0,y:0,heading:0,speed:0,steer:0 });
test('throttle, braking, reverse, steering and speed cap behave consistently', () => {
  const car = state();
  for (let i=0;i<600;i++) integrate(car,{throttle:1,steer:0},1/60,()=>false);
  assert.ok(car.speed>20 && car.speed<=44); assert.ok(car.y>100);
  for (let i=0;i<300;i++) integrate(car,{brake:true},1/60,()=>false);
  assert.equal(car.speed,0);
  for (let i=0;i<240;i++) integrate(car,{reverse:true,steer:1},1/60,()=>false);
  assert.ok(car.speed<0 && car.speed>=-9); assert.ok(car.heading<0);
});
test('maximum-speed car cannot tunnel through a thin wall', () => {
  const wall = box(-10,10,10,10.12), car=state();car.speed=44;
  let hit=false;
  for(let i=0;i<15;i++) hit=integrate(car,{throttle:1},.05,next=>carHits(next,[wall])).hit || hit;
  assert.ok(hit);assert.ok(car.y<8);assert.equal(carHits(car,[wall]),false);
});
test('full car footprint blocks corners and courtyard boundaries', () => {
  const obstacle=box(-10,-10,10,10);obstacle.holes=[box(-5,-5,5,5).outer];
  assert.equal(circleHitsPolygon({x:0,y:0},1,obstacle.outer,obstacle.holes),false);
  assert.equal(circleHitsPolygon({x:4.5,y:0},1,obstacle.outer,obstacle.holes),true);
  assert.equal(carHits({...state(),y:4},[obstacle]),true);
});
test('spawn chooses an unblocked mapped road and rejects water-only locations', () => {
  const roads=[{name:'Teststraße',tags:{highway:'residential'},points:[{x:0,y:-50},{x:0,y:50}]}];
  const spawn=findSpawn(roads,[box(-3,-3,3,3)]);
  assert.ok(spawn);assert.ok(!carHits(spawn,[box(-3,-3,3,3)]));
  assert.equal(findSpawn([],[]),null);
  assert.equal(findSpawn([{...roads[0],tags:{highway:'footway'}}],[]),null);
});
test('local coordinates round trip and wrap across the date line', () => {
  const origin={lat:52.5,lon:179.999},point={lat:52.501,lon:-179.999};
  const local=localPoint(point,origin),result=geoPoint(local,origin);
  assert.ok(Math.abs(local.x)<200);assert.ok(distance(point,result)<.001);
});
test('split multipolygon rings join into a solid building with a courtyard', () => {
  const p=(lon,lat)=>({lon,lat});
  const data={center:p(0,0),radius:1000,elements:[{type:'relation',id:1,tags:{building:'yes'},members:[
    {ref:1,role:'outer',geometry:[p(0,0),p(.001,0),p(.001,.001)]},
    {ref:2,role:'outer',geometry:[p(0,0),p(0,.001),p(.001,.001)]},
    {ref:3,role:'inner',geometry:[p(.0003,.0003),p(.0007,.0003),p(.0007,.0007),p(.0003,.0007),p(.0003,.0003)]}
  ]}]};
  const world=parseWorld(data,p(0,0));assert.equal(world.buildings.length,1);assert.equal(world.obstacles[0].holes.length,1);
  assert.equal(circleHitsPolygon(localPoint(p(.0005,.0005),p(0,0)),1,world.obstacles[0].outer,world.obstacles[0].holes),false);
});
