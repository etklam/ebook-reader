import { readFile,writeFile,unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadExportBook,bookFormatters,EXPORT_MAX_BYTES } from '../src/export/formatters.ts';
const path=process.argv[4] ?? `/tmp/cr-export-${process.pid}.txt`;
if(process.argv[2]==='child'){
 const format=process.argv[3];
 const start=performance.now();
 const book=await loadExportBook({work:{id:'book',title:'Export benchmark',author:null,description:null},versionLabel:'head',modifiedAt:new Date(0)},[{chapterId:'c',revisionId:'r',labelRaw:'1',title:'Title',contentKey:path}],[],{get:readFile,size:async()=>EXPORT_MAX_BYTES});
 const bytes=await bookFormatters[format].serialize(book);
 console.log(JSON.stringify({format,rawBytes:EXPORT_MAX_BYTES,responseBytes:bytes.length,ms:performance.now()-start,peakRssMiB:process.resourceUsage().maxRSS/1024}));
}else{
 if (!process.argv[2]) throw new Error('usage: node scripts/perf-export.mjs output.json');
 const results=[];
 try{
  for(const content of ['prose','xml-escape','paragraphs']){
   const chunk=Buffer.from(content==='prose'?'山川風雨，遠行之人繼續向前。\n\n':content==='paragraphs'?'a\n\n':'&');
   const fixture=Buffer.alloc(EXPORT_MAX_BYTES);fixture.fill(chunk);await writeFile(path,fixture);
   for(const format of ['txt','epub']){
    const child=spawnSync(process.execPath,['--max-old-space-size=512',import.meta.filename,'child',format,path],{encoding:'utf8',maxBuffer:1000000,timeout:120000});
    if(child.error || child.status!==0)throw new Error(`${content}/${format}: ${child.stderr.slice(-2000)}`);
    results.push({content,...JSON.parse(child.stdout)});
   }
  }
  await writeFile(process.argv[2],JSON.stringify({recordedAt:new Date().toISOString(),node:process.version,environment:'Linux x64, one fresh child per case, local canonical file, 512MiB V8 heap, maxRSS includes runtime',results},null,2));
  console.log(JSON.stringify(results));
 }finally{await unlink(path).catch(()=>{});}
}
