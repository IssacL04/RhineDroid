import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Matrix4, Matrix3, Vector3 } from '../web/node_modules/three/build/three.module.js';
const root = new URL('../', import.meta.url);
const output = new URL('app/src/main/assets/vulkan/', root);
await mkdir(output, {recursive:true});
const glb = await readFile(new URL('web/public/assets/music-case-v040.glb', root));
assert.equal(glb.readUInt32LE(0),0x46546c67);
const length = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20,20+length).toString());
const binary = glb.subarray(28+length);
const primitives = [[],[],[]];
function accessor(id) {
 const a=json.accessors[id],v=json.bufferViews[a.bufferView];
 const count={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
 const size={5123:2,5125:4,5126:4}[a.componentType];
 assert(count&&size&&!a.sparse);
 return Array.from({length:a.count},(_,i)=>Array.from({length:count},(_,c)=>{
  const offset=(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||count*size)+c*size;
  return a.componentType===5126?binary.readFloatLE(offset):size===2?binary.readUInt16LE(offset):binary.readUInt32LE(offset);
 }));
}
function node(index,parent=new Matrix4()) {
 const n=json.nodes[index],local=n.matrix?new Matrix4().fromArray(n.matrix):new Matrix4();
 const matrix=parent.clone().multiply(local),normal=new Matrix3().getNormalMatrix(matrix);
 if(n.mesh!==undefined)for(const primitive of json.meshes[n.mesh].primitives){
  const positions=accessor(primitive.attributes.POSITION),normals=accessor(primitive.attributes.NORMAL),indices=accessor(primitive.indices).flat();
  const name=json.materials[primitive.material].name;
  const target=primitives[name.startsWith('Frosted_Polymer')?1:0];
  for(const i of indices){const p=new Vector3(...positions[i]).applyMatrix4(matrix),v=new Vector3(...normals[i]).applyNormalMatrix(normal);target.push(p.x,p.y,p.z,v.x,v.y,v.z,name==='Ivory_Edges'?1:0,0);}
 }
 for(const child of n.children||[])node(child,matrix);
}
// The source GLB stores its authored final geometry in identity nodes.
for(const n of json.nodes)assert(!n.translation&&!n.rotation&&!n.scale,'Handle a new source node transform before exporting');
for(const index of json.scenes[json.scene||0].nodes)node(index);
const spineVertices=primitives[0].filter((value,i)=>i%8===6 && value===1).length;
assert(spineVertices>0 && spineVertices<primitives[0].length/8,'Keep a distinct spine tag within the shared transparent shell mesh');
const x=.17,y=1.85,z=.027,h=3.06/2;
for(const [a,b,u,v]of[[-1,-1,0,1],[1,-1,1,1],[-1,1,0,0],[-1,1,0,0],[1,-1,1,1],[1,1,1,0]])primitives[2].push(x+a*h,y+b*h,z,0,0,1,u,v);
const chunks=[];
const header=Buffer.alloc(12);header.write('RHVK');header.writeUInt32LE(1,4);header.writeUInt32LE(3,8);chunks.push(header);
primitives.forEach((values,kind)=>{assert(values.length&&values.every(Number.isFinite));const count=values.length/8;assert(count<65536&&count%3===0);const head=Buffer.alloc(8);head.writeUInt32LE(kind);head.writeUInt32LE(count,4);const data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeFloatLE(v,i*4));chunks.push(head,data);});
await writeFile(new URL('archive.mesh',output),Buffer.concat(chunks));
let source=await readFile(new URL('app/src/main/materials/archive.mat',root),'utf8');
const layout=await readFile(new URL('app/src/main/java/com/enc3l/rhinedroid/ShelfLayout.kt',root),'utf8');
const columns=Number(layout.match(/const val COLUMNS = (\d+)/)[1]),rows=Number(layout.match(/const val ROWS = (\d+)/)[1]);
const poolCount=columns*rows;
assert(poolCount*4*16+512<=16384 && poolCount<=256,'Keep poses within the Vulkan minimum UBO size and atlas capacity');
source=source.replaceAll('@POOL_COUNT@',String(poolCount)).replaceAll('@SELECTED@',String(Math.floor(poolCount/2)));

const decryption=await readFile(new URL('web/src/decryption.ts',root),'utf8');
const curves=['GROW','REVEAL','RETRACT'].map(name=>{
 const knots=JSON.parse('['+decryption.match(new RegExp('const '+name+':[^=]+=[\\s]*\\[([\\s\\S]*?)\\];'))[1].replace(/,\s*$/,'')+']');
 const secant=i=>(knots[i+1][1]-knots[i][1])/(knots[i+1][0]-knots[i][0]);
 const slope=i=>{if(i===0||i===knots.length-1)return 0;const a=secant(i-1),b=secant(i);if(a*b<=0)return 0;const l=knots[i][0]-knots[i-1][0],r=knots[i+1][0]-knots[i][0];return ((2*r+l)+(r+2*l))/((2*r+l)/a+(r+2*l)/b);};
 const n=value=>Number(value).toFixed(9);
 return 'float curve'+name+'(float time) { if(time<='+n(knots[0][0])+')return '+n(knots[0][1])+';'+knots.slice(0,-1).map(([x,y],i)=>{
  const [end,value]=knots[i+1],span=end-x;
  return 'if(time<'+n(end)+'){float t=(time-'+n(x)+')/'+n(span)+';return (2.0*t*t*t-3.0*t*t+1.0)*'+n(y)+'+(t*t*t-2.0*t*t+t)*'+n(span*slope(i))+'+(-2.0*t*t*t+3.0*t*t)*'+n(value)+'+(t*t*t-t*t)*'+n(span*slope(i+1))+';}';
 }).join('')+'return '+n(knots.at(-1)[1])+';}';
}).join('\n');
source=source.replace('/* DECRYPTION_CURVES */',curves);
for(const glass of [false,true]) {
 const path=new URL(glass?'archive-glass.mat':'archive-opaque.mat',output);
 const expected=glass?source.replace('name : RhineVulkanArchive,','name : RhineVulkanArchiveGlass,\n    blending : transparent,\n    depthWrite : false,'):source;
 if(process.env.FILAMENT_MATC) {
  assert.equal(execFileSync(process.env.FILAMENT_MATC,['--version'],{encoding:'utf8'}).trim(),'77','Use Filament 1.77.2 matc');
  await writeFile(path,expected);
  execFileSync(process.env.FILAMENT_MATC,['-p','mobile','-a','vulkan','-o',new URL(glass?'glass.filamat':'opaque.filamat',output).pathname,path.pathname],{stdio:'inherit'});
 } else assert.equal(await readFile(path,'utf8'),expected,'Material changed: recompile with FILAMENT_MATC from Filament v1.77.2');
}
for(const name of ['opaque.filamat','glass.filamat'])assert((await readFile(new URL(name,output))).length>1000,'Compile materials with FILAMENT_MATC from Filament v1.77.2');
console.log('Vulkan assets: authored GLB converted; 3 GPU-instanced primitives; Vulkan-only materials present.');
