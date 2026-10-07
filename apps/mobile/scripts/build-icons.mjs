/** Mobile-only assets from the canonical brand vectors. Run with Node; --check
 * verifies deterministic outputs without writing. Uses existing Playwright's
 * pinned Chromium and the repo's 4x canvas supersampling, with explicit RGB PNG
 * encoding for opaque store icons (an opaque RGBA image still has alpha). */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const mobile=resolve(root,'apps/mobile'), check=process.argv.includes('--check');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources=['brand/app-icon.svg','brand/app-icon-maskable.svg'].map(path=>({path,bytes:readFileSync(resolve(root,path)),commit:execFileSync('git',['log','-1','--format=%H','--',path],{cwd:root,encoding:'utf8'}).trim()}));
const mask=sources[1].bytes.toString('utf8');
if(!mask.includes('<rect width="1024" height="1024" fill="#000000"/>'))throw new Error('Review changed maskable SVG structure before rendering.');
const foreground=mask.replace('<rect width="1024" height="1024" fill="#000000"/>','');
const monochrome=foreground.replaceAll('#ff6b35','#ffffff');
function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let b=0;b<8;b++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function png(width,height,rgba,alpha){const channels=alpha?4:3,rows=Buffer.alloc(height*(1+width*channels));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const src=(y*width+x)*4,dst=y*(1+width*channels)+1+x*channels;rows[dst]=rgba[src];rows[dst+1]=rgba[src+1];rows[dst+2]=rgba[src+2];if(alpha)rows[dst+3]=rgba[src+3];else if(rgba[src+3]!==255)throw new Error('Opaque icon contains translucent pixels');}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=alpha?6:2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
const writes=new Map(),assets=[];
function output(path,bytes,metadata){writes.set(path,Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes));if(metadata)assets.push({path,...metadata,sha256:digest(bytes)});}
const browser=await chromium.launch({headless:true,args:['--disable-gpu','--force-device-scale-factor=1']});
let renderer;
try{
  renderer=browser.version();const page=await browser.newPage({deviceScaleFactor:1});
  await page.goto('about:blank');
  const memo=new Map();
  async function render(svg,size,alpha=false,shape='square'){
    const key=digest(svg)+':'+size+':'+alpha+':'+shape;if(memo.has(key))return memo.get(key);
    const encoded=await page.evaluate(async({svg,size,shape})=>{
      const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(svg);await image.decode();
      const big=new OffscreenCanvas(size*4,size*4),bx=big.getContext('2d');
      if(shape==='circle'){bx.beginPath();bx.arc(size*2,size*2,size*2,0,Math.PI*2);bx.clip();}
      bx.drawImage(image,0,0,size*4,size*4);
      const canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(big,0,0,size,size);
      const bytes=ctx.getImageData(0,0,size,size).data;let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
    },{svg,size,shape});
    const raw=Buffer.from(encoded,'base64');
    if(svg===foreground||svg===monochrome){for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(raw[(y*size+x)*4+3]>0&&Math.hypot(x+.5-size/2,y+.5-size/2)>size*33/108)throw new Error('Adaptive glyph exceeds the 66/108 safe circle');}
    const result=png(size,size,raw,alpha);memo.set(key,result);return result;
  }
  const icon='ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';output(icon,await render(mask,1024),{width:1024,height:1024,colorType:2,source:sources[1].path});
  for(const [density,scale] of [['mdpi',1],['hdpi',1.5],['xhdpi',2],['xxhdpi',3],['xxxhdpi',4]]){
    const base='android/app/src/main/res/mipmap-'+density+'/';
    output(base+'ic_launcher.png',await render(mask,48*scale),{width:48*scale,height:48*scale,colorType:2,source:sources[1].path});
    output(base+'ic_launcher_round.png',await render(mask,48*scale,true,'circle'),{width:48*scale,height:48*scale,colorType:6,source:sources[1].path});
    for(const [name,svg] of [['foreground',foreground],['monochrome',monochrome]])output(base+'ic_launcher_'+name+'.png',await render(svg,108*scale,true),{width:108*scale,height:108*scale,colorType:6,safeCircleDp:66,source:sources[1].path});
  }
}finally{await browser.close();}
const res='android/app/src/main/res/';
for(const api of [26,33])for(const name of ['ic_launcher','ic_launcher_round'])output(res+`mipmap-anydpi-v${api}/${name}.xml`,`<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>${api===33?'\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>':''}\n</adaptive-icon>\n`);
output(res+'values/ic_launcher_background.xml','<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#000000</color></resources>\n');
output(res+'drawable/ic_launcher_background.xml','<?xml version="1.0" encoding="utf-8"?>\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle"><solid android:color="#000000"/></shape>\n');
output(res+'drawable-v24/ic_launcher_foreground.xml','<?xml version="1.0" encoding="utf-8"?>\n<bitmap xmlns:android="http://schemas.android.com/apk/res/android" android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>\n');
// Native launch remains a plain ground; Android may display the branded launcher
// through its OS splash animation. No web splash overlay or delay is introduced.
const black=png(1,1,Buffer.from([0,0,0,255]),false);
for(const directory of readdirSync(resolve(mobile,res))){const rel=res+directory+'/splash.png';if(existsSync(resolve(mobile,rel)))output(rel,black,{width:1,height:1,colorType:2,purpose:'plain native splash ground'});}
const splash='ios/App/App/Assets.xcassets/Splash.imageset/';
const splashContents=JSON.parse(readFileSync(resolve(mobile,splash+'Contents.json'),'utf8'));
for(const {filename,scale} of splashContents.images)if(filename){const size=Number.parseInt(scale??'1',10);output(splash+filename,png(size,size,Buffer.from(Array(size*size).fill([0,0,0,255]).flat()),false),{width:size,height:size,colorType:2,purpose:'plain native splash ground'});}
const styles=res+'values/styles.xml';let xml=readFileSync(resolve(mobile,styles),'utf8');
xml=xml.replace(/<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">[\s\S]*?<\/style>/,'<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="android:background">@drawable/splash</item>\n        <item name="windowSplashScreenBackground">@color/ic_launcher_background</item>\n        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>\n        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>\n    </style>');
if(!xml.includes('name="windowSplashScreenAnimatedIcon"'))throw new Error('Native launch theme missing');output(styles,xml);
const storyboard='ios/App/App/Base.lproj/LaunchScreen.storyboard';
output(storyboard,readFileSync(resolve(mobile,storyboard),'utf8').replace('<color white="1" alpha="1"','<color white="0" alpha="1"').replace(/<image name="Splash" width="[^"]+" height="[^"]+"\/>/,'<image name="Splash" width="1" height="1"/>'));
const manifest={schema:1,sources:sources.map(({path,bytes,commit})=>({path,commit,sha256:digest(bytes)})),renderer:{engine:'Chromium',version:renderer,algorithm:'4x canvas supersampling; explicit RGB/RGBA PNG level9'},outputs:assets,notes:['No desktop/browser assets regenerated.','iOS icon is RGB color-type2; adaptive glyphs fit centered66dp circle in108dp layer.','Monochrome is the canonical glyph recolored white; Android applies theme tint.','Source/build assets only; OS appearance and store qualification are separate.']};
output('icon-assets-manifest.json',JSON.stringify(manifest,null,2)+'\n');
let drift=0;
for(const [path,bytes] of writes){const file=resolve(mobile,path),same=existsSync(file)&&readFileSync(file).equals(bytes);if(!same)drift++;if(!check){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){const meta=assets.find(a=>a.path===path);if(bytes.readUInt32BE(16)!==meta.width||bytes.readUInt32BE(20)!==meta.height||bytes[25]!==meta.colorType)throw new Error('PNG header mismatch: '+path);}}
for(const name of ['ic_launcher','ic_launcher_round'])if(!readFileSync(resolve(mobile,'android/app/src/main/AndroidManifest.xml'),'utf8').includes('@mipmap/'+name))throw new Error('Android launcher manifest reference missing');
const appIconContents=JSON.parse(readFileSync(resolve(mobile,'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json'),'utf8'));
if(!appIconContents.images.some(v=>v.filename==='AppIcon-512@2x.png'&&v.size==='1024x1024'))throw new Error('iOS icon resource reference mismatch');
console.log(JSON.stringify({mode:check?'check':'write',files:writes.size,pngs:assets.length,drift,renderer,sources:manifest.sources},null,2));
if(check&&drift)process.exitCode=1;
