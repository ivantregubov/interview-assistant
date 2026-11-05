// Настоящая загрузка модели через сеть Electron, распознавание подменено.
const { _electron: electron } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-dl-'));
  const userData = path.join(root, 'ud'); fs.mkdirSync(userData);
  const sample = path.join(root, 'a.wav');
  require('child_process').execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2',sample]);
  fs.writeFileSync(path.join(userData,'settings.json'), JSON.stringify({modelQuality:'fast'}));
  const app = await electron.launch({ executablePath:path.join(__dirname, '../node_modules/electron/dist/electron'), args:[path.join(__dirname, '..'),'--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--disable-gpu'], env:{...process.env,IR_TEST:'1',IR_TEST_SHOW:'1',IR_TEST_USER_DATA:userData,IR_TEST_WHISPER:path.join(__dirname,'fake-whisper.js'),IR_FAKE_LOG:path.join(root,'l')} });
  const win = await app.firstWindow(); await win.waitForLoadState();
  await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]})},sample);
  await win.click('[data-action=transcribeExisting]');
  let shown=false;
  for (let i=0;i<600;i+=1){ await win.waitForTimeout(500);
    const t=await win.evaluate(()=>({title:document.getElementById('progress-title').textContent,pct:document.getElementById('progress-text').textContent,hidden:document.getElementById('progress-card').hidden,err:document.getElementById('transcription-error-text').textContent}));
    if(!shown&&!t.hidden&&t.title.startsWith('Скачиваю')&&t.pct!=='0%'){shown=true;console.log('progress',t);await win.screenshot({path:process.argv[2]+'/win-download.png'});}
    if(t.err){console.log('ERR',t.err);break;}
    if(fs.existsSync(path.join(root,'a.transcript.md'))){console.log('done');break;}
  }
  const m=path.join(userData,'models','ggml-small-q5_1.bin');
  console.log('model size',fs.existsSync(m)&&fs.statSync(m).size, 'expected 190085487', fs.readdirSync(path.join(userData,'models')));
  await app.close(); process.exit(0);
})().catch(e=>{console.error('FAILED',e);process.exit(1)});
