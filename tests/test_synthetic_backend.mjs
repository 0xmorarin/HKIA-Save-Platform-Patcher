// Regression for the actual patched PR#1 parser.js (run from project root).
// Does not need or distribute user save data.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {parseSave,patchSavePlatform}=await import(pathToFileURL(path.join(process.cwd(),'parser.js')).href);
const SOURCE_IDS=[1,4,5,6,7,9,10],TARGET_IDS=[1,7,9,10];
const grp=(n)=>[4,5,6,7].includes(n)?'apple':String(n);
const mappedDlc=n=>[4,5,6,7].includes(n)?2:n===1?4:n===9?3:5;
const mpNum=n=>n<=127?[n]:[0xcc,n];
const mpArr=parts=>[0x90+parts.length,...parts.flat()];
const guid=parts=>parts.flatMap(mpNum);
const VERSION=Array.from('3.0.0',ch=>ch.charCodeAt(0));
const HEADER=new Uint8Array(32);
const MAGIC=Uint8Array.from([0xa1,0xa2,0xf8,0x33,0x3c,0x66,0xec,0x45,0x5b,0xaa,0x2d,0xfc,0x63,0x25,0xc2,0x43,0x7a,0x77,0x9c,0x99,0x06,0xee,0xcf,0xf0,0xc0,0x22,0xe5,0xf6,0xb6,0xca,0x73,0xb8]);
const ID_A=[11,22,33,44],ID_B=[55,66,77,88],ID_C=[12,34,56,78];
function buildDlcModel(dlc){
  const bundles=mpArr([
    mpArr([guid(ID_A),[0xc3],mpArr([mpNum(dlc)])]),
    mpArr([guid(ID_B),[0xc2],mpArr([])])
  ]);
  const contents=mpArr([mpArr([guid(ID_C),[0xc3],mpArr([guid(ID_A)])])]);
  const body=mpArr([mpNum(2),bundles,contents,mpArr([mpNum(dlc)])]);
  return mpArr([[0xd2,0,0,0,30],body]);
}
function buildFixture(platform,{lz4=true}={}){
  const prefix=[...HEADER,0x98,...guid([1,2,3,4]),0xa5,...VERSION,1,0xc0,4,0x80,0x90,0x91,platform];
  if(!lz4)return Uint8Array.from(prefix);
  const raw=mpArr([mpNum(1),mpNum(1),mpArr([buildDlcModel(mappedDlc(platform))])]);
  assert.ok(raw.length>15&&raw.length<127);
  const compressed=[0xf0,raw.length-15,...raw]; // Valid final literal-only LZ4 block
  const wrapper=[0x92,0xc7,1,98,raw.length,0xc6,0,0,0,compressed.length,...compressed];
  return Uint8Array.from([...prefix,...MAGIC,...wrapper]);
}
function rawLz4Payload(file){
  let offset=-1;
  outer:for(let i=0;i<=file.length-MAGIC.length;i++){
    for(let j=0;j<MAGIC.length;j++)if(file[i+j]!==MAGIC[j])continue outer;
    offset=i+MAGIC.length;break;
  }
  assert.ok(offset>=0,'LZ4 marker missing');
  assert.equal(file[offset++],0x92,'fixture must have one LZ4 block');
  assert.equal(file[offset++],0xc7);
  assert.equal(file[offset++],1);
  assert.equal(file[offset++],98);
  const expected=file[offset++];
  assert.equal(file[offset++],0xc6);
  const length=(((file[offset]*0x1000000)+(file[offset+1]<<16)+(file[offset+2]<<8)+file[offset+3])>>>0);offset+=4;
  const block=file.subarray(offset,offset+length),out=[];
  let pos=0;
  while(pos<block.length){
    const token=block[pos++];let n=token>>>4;
    if(n===15){let x;do{x=block[pos++];n+=x}while(x===255)}
    for(let j=0;j<n;j++)out.push(block[pos++]);
    if(pos===block.length)break;
    const dist=block[pos]|block[pos+1]<<8;pos+=2;
    assert.ok(dist>0&&dist<=out.length,'invalid LZ4 match distance');
    let count=token&15;
    if(count===15){let x;do{x=block[pos++];count+=x}while(x===255)}
    count+=4;
    for(let j=0;j<count;j++)out.push(out[out.length-dist]);
  }
  assert.equal(out.length,expected,'LZ4 decompressed length mismatch');
  return Uint8Array.from(out);
}
let headerTests=0,dlcTests=0,rejections=0;
for(const source of SOURCE_IDS){
  for(const target of TARGET_IDS){
    if(grp(source)===grp(target)){
      assert.throws(()=>patchSavePlatform(buildFixture(source,{lz4:false}),target),{code:'unsupported_platform'});
      rejections++;continue;
    }
    // Header-only save is not a valid full HKIA save: do not emit a truncated file.
    assert.throws(()=>patchSavePlatform(buildFixture(source,{lz4:false}),target),{code:'verification_failed'});headerTests++;
    const input=buildFixture(source),out=patchSavePlatform(input,target);
    assert.equal(parseSave(out.bytes).platformType,target);
    const original=rawLz4Payload(input),changed=rawLz4Payload(out.bytes);
    assert.equal(changed.length,original.length,'DLC payload unexpectedly resized');
    const changedOffsets=[...original.keys()].filter(i=>original[i]!==changed[i]);
    assert.equal(changedOffsets.length,2,'Expected one DLC bundle platform and one seenPlatforms update');
    assert.ok(changedOffsets.every(i=>changed[i]===mappedDlc(target)));
    const back=patchSavePlatform(out.bytes,[4,5,6].includes(source)?7:source);
    assert.deepEqual(rawLz4Payload(back.bytes),original,'Round-trip altered non-platform DLC state');
    dlcTests++;
  }
}
for(const bad of [0,2,3,8,11,12,99,128,-1,undefined]){
  assert.throws(()=>patchSavePlatform(buildFixture(1),bad),{code:'unsupported_platform'});rejections++;
}
for(const bad of [0,2,3,8,11,12,99]){
  assert.throws(()=>patchSavePlatform(buildFixture(bad),9),{code:'unsupported_platform'});rejections++;
}
console.log(JSON.stringify({status:'PASS',missingLz4Rejections:headerTests,dlcRoundtrips:dlcTests,expectedRejections:rejections,total:headerTests+dlcTests+rejections},null,2));
