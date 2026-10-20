import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import * as T from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
async function load(path) {
 const b=await readFile(new URL(path,import.meta.url));
 const s=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),"")).scene;
 s.updateMatrixWorld(true);return s;
}
const [chosen,previous,current]=await Promise.all([
 load("../reference/internal-study/assembly-before.glb"),
 load("../reference/ring-study/assembly-before.glb"),
 load("../public/assets/archive-assembly.glb"),
]);
function collect(scene,interior) {
 const result=new Map();
 scene.traverse(m=>{
  if(!m.isMesh)return;
  const isInterior=["optical-core","optical-lenses"].includes(m.userData.assemblyPart);
  if(isInterior!==interior)return;
  const p=m.geometry.attributes.position,n=m.geometry.attributes.normal,nm=new T.Matrix3().getNormalMatrix(m.matrixWorld),rows=[];
  for(let i=0;i<p.count;i++) {
   const v=new T.Vector3().fromBufferAttribute(p,i).applyMatrix4(m.matrixWorld);
   const normal=new T.Vector3().fromBufferAttribute(n,i).applyNormalMatrix(nm);
   rows.push([...v.toArray(),...normal.toArray()].map(x=>x.toFixed(5)).join(","));
  }
  result.set(m.userData.assemblyPart+":"+m.material.name.replace(/\.\d+$/,""),{rows:rows.sort(),color:m.material.color.toArray().map(x=>x.toFixed(6)),roughness:m.material.roughness,metalness:m.material.metalness});
 });return result;
}
assert.deepEqual(collect(current,true),collect(chosen,true),"Restore the chosen first-version interior geometry, normals and source materials");
assert.deepEqual(collect(current,false),collect(previous,false),"Keep the refined outer case unchanged");
console.log(JSON.stringify({passed:true,interior:"matches chosen first version",outerCase:"unchanged",precision:1e-5},null,2));
