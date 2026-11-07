import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spaceRequirement, floorFor, implicatedVolumes, volumeLayout} from './backup-space.mjs';
const calc=(extra={})=>spaceRequirement({layout:'split',estimates:{backup:100,data:100},free:{backup:200,data:200},...extra});
test('estimates use both components, summed only on shared volumes',()=>{
 assert.equal(calc().short,false); assert.equal(calc({free:{backup:200,data:99}}).drive,'data');
 assert.equal(calc({layout:'shared',free:{shared:150}}).requiredBytes,200);
 assert.equal(calc({layout:'shared',free:{shared:200}}).short,false);
 assert.equal(calc({estimates:{},free:{}}).short,false);
});
test('pinned floors combine with estimates by max, never sum',()=>{
 const room={mode:'pinned',floors:{backup:300}};
 assert.equal(calc({room}).requiredBytes,300);assert.equal(calc({room,free:{backup:300,data:200}}).short,false);
 assert.equal(calc({room:{mode:'pinned',floors:{shared:300}},layout:'shared',free:{shared:300}}).short,false);
});
test('either admits when either floor clears but always enforces estimates',()=>{
 const room={mode:'either',floors:{backup:300,data:400}};
 assert.equal(calc({room}).short,true);
 assert.equal(calc({room,free:{backup:300,data:200}}).short,false);
 assert.equal(calc({room,free:{backup:200,data:400}}).short,false);
 assert.equal(calc({room,free:{backup:99,data:400}}).short,true);
});
test('unknown reads block only with history; null floors require known space at estimate',()=>{
 assert.equal(calc({free:{}}).short,false);
 const room={mode:'pinned',floors:{data:null}};
 assert.equal(calc({room,free:{backup:200}}).short,true);
 assert.equal(calc({room,free:{backup:200}}).neededBytes,undefined);
 assert.equal(calc({room,free:{backup:200,data:100}}).short,false);
 assert.equal(calc({room,free:{backup:200,data:101}}).short,false);
 assert.equal(calc({room:{mode:'either',floors:{backup:null,data:null}},free:{backup:101}}).short,true);
});
test('floor includes measured leftovers and the larger margin',()=>{
 assert.equal(floorFor(undefined,4),null);assert.equal(floorFor(100,4),100+4+256*1024**2);
 assert.equal(floorFor(10*1024**3,100),12*1024**3+100);
});
test('every capture step maps to the physical writers',()=>{
 for(const step of ['stage','inventory','manifest','readback'])assert.deepEqual(implicatedVolumes(step,'linux'),['data']);
 for(const step of ['encrypt','flush','publish','private-stage'])assert.deepEqual(implicatedVolumes(step,'linux'),['backup']);
 for(const step of ['private-stage','offline-open','tool','worker',undefined])assert.deepEqual(implicatedVolumes(step,'win32'),['backup','data']);
});

test('T-volume-unknown: uncertain identities charge the summed estimate on both paths',()=>{
 const GiB=1024**3;
 for(const ids of [[0,0],[undefined,1],[1,undefined]]){
  const layout=volumeLayout(...ids);assert.equal(layout,'unknown');
  const result=calc({layout,estimates:{backup:12*GiB,data:12*GiB},free:{backup:13*GiB,data:13*GiB}});
  assert.equal(result.short,true);assert.equal(result.requiredBytes,24*GiB);assert.equal(result.neededBytes,11*GiB);
  assert.equal(calc({layout,estimates:{backup:12*GiB,data:12*GiB},free:{backup:24*GiB,data:24*GiB}}).short,false);
 }
 assert.equal(volumeLayout(1,2),'split');assert.equal(volumeLayout(1,1),'shared');
});
test('T-status: estimates precede floors and a satisfied alternative is not a blocker',()=>{
 const room={layout:'split',mode:'either',floors:{backup:300,data:400}};
 assert.equal(calc({room,free:{backup:200,data:99}}).drive,'data');
 assert.equal(calc({room,free:{backup:200,data:150}}).drive,'backup');
 const ok=calc({room,free:{backup:300,data:100}});assert.equal(ok.short,false);assert.equal(ok.drive,null);
 assert.equal(ok.volumes[1].blocking,false);assert.equal(ok.volumes[1].alternative,true);
});
test('T-A3: layout changes keep measured floors and never add physical observations',()=>{
 const room={layout:'split',mode:'either',floors:{backup:300,data:400}};
 assert.equal(calc({room,layout:'shared',free:{shared:399}}).requiredBytes,400);
 assert.equal(calc({room,layout:'shared',free:{shared:400}}).short,false);
 const shared={layout:'shared',mode:'pinned',floors:{shared:400}};
 assert.equal(calc({room:shared,layout:'unknown',free:{backup:400,data:200}}).short,false);
 assert.equal(calc({room:shared,layout:'unknown',free:{backup:399,data:399}}).short,true);
});
