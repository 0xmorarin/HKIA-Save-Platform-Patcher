import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {parseSave,patchSavePlatform}=await import(pathToFileURL(path.join(process.cwd(),'parser.js')).href);
const SOURCE_IDS=[1,4,5,6,7,9,10,12],TARGET_IDS=[1,7,9,10];
const grp=(n)=>[4,5,6,7].includes(n)?'apple':(n===9||n===12)?'switch':String(n);
const mappedDlc=n=>[4,5,6,7].includes(n)?2:n===1?4:(n===9||n===12)?3:5;
const mpNum=n=>n<=127?[n]:n<=255?[0xcc,n]:n<=65535?[0xcd,n>>>8,n&255]:[0xce,(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];
const mpArr=parts=>[0x90+parts.length,...parts.flat()];
const guid=parts=>parts.flatMap(mpNum);
const VERSION=Array.from('3.0.0',ch=>ch.charCodeAt(0));
const HEADER=new Uint8Array(32);
const MAGIC=Uint8Array.from([0xa1,0xa2,0xf8,0x33,0x3c,0x66,0xec,0x45,0x5b,0xaa,0x2d,0xfc,0x63,0x25,0xc2,0x43,0x7a,0x77,0x9c,0x99,0x06,0xee,0xcf,0xf0,0xc0,0x22,0xe5,0xf6,0xb6,0xca,0x73,0xb8]);
const ID_A=[11,22,33,44],ID_B=[55,66,77,88],ID_C=[12,34,56,78];
function buildDlcModel(dlc,modelId=2){
  const bundles=mpArr([
    mpArr([guid(ID_A),[0xc3],mpArr([mpNum(dlc)])]),
    mpArr([guid(ID_B),[0xc2],mpArr([])])
  ]);
  const contents=mpArr([mpArr([guid(ID_C),[0xc3],mpArr([guid(ID_A)])])]);
  const body=mpArr([mpNum(modelId),bundles,contents,mpArr([mpNum(dlc)])]);
  return mpArr([[0xd2,0,0,0,30],body]);
}
function buildFixture(platform,{lz4=true,modelId=2,nextId=Math.max(3,modelId+1),encoding="fixint"}={}){
  const encodings={fixint:[platform],uint8:[0xcc,platform],uint16:[0xcd,0,platform],int8:[0xd0,platform]};
  const prefix=[...HEADER,0x98,...guid([1,2,3,4]),0xa5,...VERSION,1,0xc0,4,0x80,0x90,0x91,...encodings[encoding]];
  if(!lz4)return Uint8Array.from(prefix);
  const raw=mpArr([mpNum(1),mpNum(nextId),mpArr([buildDlcModel(mappedDlc(platform),modelId)])]);
  assert.ok(raw.length>15&&raw.length<127);
  const compressed=[0xf0,raw.length-15,...raw];
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
let headerTests=0,preservationTests=0,rejections=0,dynamicCases=0,encodingCases=0,malformedIdCases=0;
for(const source of SOURCE_IDS){
  for(const target of TARGET_IDS){
    if(grp(source)===grp(target)){
      assert.throws(()=>patchSavePlatform(buildFixture(source,{lz4:false}),target),{code:'unsupported_platform'});
      rejections++;
      continue;
    }
    assert.throws(()=>patchSavePlatform(buildFixture(source,{lz4:false}),target),{code:'verification_failed'});
    headerTests++;
    const input=buildFixture(source);
    const out=patchSavePlatform(input,target);
    const before=parseSave(input);
    assert.equal(parseSave(out.bytes).platformType,target);
    assert.equal(out.bytes.length,input.length);
    assert.deepEqual(rawLz4Payload(out.bytes),rawLz4Payload(input));
    for(let i=0;i<input.length;i++){
      if(i>=before.platformOffset && i<before.platformOffset+before.platformTokenLength)continue;
      assert.equal(out.bytes[i],input[i],'Unexpected modification outside PlatformType');
    }
    assert.equal(out.bytes[before.platformOffset],target);
    if(source!==12){
      const back=patchSavePlatform(out.bytes,[4,5,6].includes(source)?7:source);
      if(source!==4 && source!==5 && source!==6)assert.deepEqual(back.bytes,input,'Round-trip altered original save');
      assert.deepEqual(rawLz4Payload(back.bytes),rawLz4Payload(input));
    }
    preservationTests++;
  }
}
for(const modelId of [2,137,5429,65535]){
  for(const source of SOURCE_IDS){
    const input=buildFixture(source,{modelId});
    const target=source===1?9:1;
    const out=patchSavePlatform(input,target);
    assert.equal(parseSave(out.bytes).platformType,target);
    assert.deepEqual(rawLz4Payload(input),rawLz4Payload(out.bytes));
    dynamicCases++;
  }
}
for(const encoding of ['fixint','uint8','uint16','int8']){
  for(const source of SOURCE_IDS){
    const input=buildFixture(source,{encoding});
    const target=source===1?9:1;
    const out=patchSavePlatform(input,target);
    const before=parseSave(input);
    assert.equal(parseSave(out.bytes).platformType,target);
    assert.equal(out.bytes.length,input.length);
    for(let i=0;i<input.length;i++){
      if(i>=before.platformOffset&&i<before.platformOffset+before.platformTokenLength)continue;
      assert.equal(out.bytes[i],input[i]);
    }
    encodingCases++;
  }
}
const unusual=buildFixture(7,{modelId:5429,nextId:100});
const unchangedDlc=patchSavePlatform(unusual,9);
assert.deepEqual(rawLz4Payload(unchangedDlc.bytes),rawLz4Payload(unusual));
malformedIdCases++;
for(const bad of [0,2,3,8,11,12,99,128,-1,undefined]){
  assert.throws(()=>patchSavePlatform(buildFixture(1),bad),{code:'unsupported_platform'});
  rejections++;
}
for(const bad of [0,2,3,8,11,99]){
  assert.throws(()=>patchSavePlatform(buildFixture(bad),9),{code:'unsupported_platform'});
  rejections++;
}
assert.throws(()=>patchSavePlatform(buildFixture(9).subarray(0,buildFixture(9).length-1),1),{code:'verification_failed'});
rejections++;
assert.throws(()=>patchSavePlatform(buildFixture(12),9),{code:'unsupported_platform'});
rejections++;
console.log(JSON.stringify({status:'PASS',missingLz4Rejections:headerTests,preservationTests,expectedRejections:rejections,dynamicIdTests:dynamicCases,encodingTests:encodingCases,opaqueDlcIdTests:malformedIdCases,total:headerTests+preservationTests+rejections+dynamicCases+encodingCases+malformedIdCases},null,2));
