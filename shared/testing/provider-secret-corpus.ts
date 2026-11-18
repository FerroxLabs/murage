// Synthetic fixtures assembled from pieces. Seed and corpus identity are pinned by the golden.
export const vendors = [
  ['temporary', 'AS' + 'IA' + 'C'.repeat(16)],
  ['permanent', 'AK' + 'IA' + 'D'.repeat(16)],
  ['notion-old', 'sec' + 'ret_' + 'E'.repeat(43)],
  ['notion-new', 'nt' + 'n_' + 'F'.repeat(43)],
  ['perplexity', 'pp' + 'lx-' + 'G'.repeat(32)],
] as const;
export const session = 'IQ' + 'oJ' + 'Hj7+/'.repeat(30) + '==';
export const fields = ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'SessionToken', 'X-Amz-Security-Token'];
export const plainForms = [
  ...vendors.flatMap(([kind, value]) => [
    {id:kind+'/bare', text:`before ${value} after`, material:value},
    {id:kind+'/env', text:`RESULT=${value}`, material:value},
    {id:kind+'/json', text:JSON.stringify({result:value}), material:value},
    {id:kind+'/query', text:`https://example.invalid/?result=${value}&page=next`, material:value},
    ...['\n','\r\n'].flatMap(eol => ['', '  '].map(indent => ({
      id:kind+'/fold/'+JSON.stringify([eol,indent]), text:value.slice(0,-8)+eol+indent+value.slice(-8), material:value,
    }))),
  ]),
  ...fields.flatMap(field => [
    {id:field+'/bare', text:field+'='+session, material:session},
    {id:field+'/env', text:field+'='+session, material:session},
    {id:field+'/json', text:JSON.stringify({[field]:session}), material:session},
    {id:field+'/query', text:`https://example.invalid/?${field}=${encodeURIComponent(session)}&page=next`, material:encodeURIComponent(session)},
    ...['\n','\r\n'].flatMap(eol => ['', '  '].map(indent => ({
      id:field+'/fold/'+JSON.stringify([eol,indent]), text:field+'='+session.slice(0,-8)+eol+indent+session.slice(-8), material:session,
    }))),
  ]),
];
const child = vendors[0][1], pp = vendors[4][1];
export const witnesses = [
  ['google', 'AI'+'za'+'B'.repeat(14)+'-'+child],
  ['sendgrid', 'SG'+'.'+'A'.repeat(22)+'.'+'B'.repeat(22)+'-'+child],
  ['card', pp+'-'+'4111'+' 1111'.repeat(3)],
  ['newline', pp+'-Authorization: abcdefgh\n'+'Q'.repeat(12)],
  ['repeated', pp+'-pp'+'lx-'+'Z'.repeat(10)+'\n  '+'Z'.repeat(22)],
  ['pp-sendgrid', pp+' SG'+'.'+'A'.repeat(22)+'.'+'B'.repeat(10)+'\n  '+'B'.repeat(33)],
  ['notion-pp', vendors[2][1]+' '+pp.slice(0,-8)+'\n  '+pp.slice(-8)],
  ['basic-splice', 'Authorization: Basic '+'B'.repeat(24)+'; result '+pp],
  ['basic-overlap', 'Authorization: Basic '+child+'-trailing-material'],
  ['pem-open', 'before -----BEGIN PRIVATE '+'KEY-----\n'+pp],
  ['pem-closed', '-----BEGIN PRIVATE '+'KEY-----\n'+pp+'\n-----END PRIVATE '+'KEY----- after'],
  ['literal', 'literal-'+pp+' literal-'+pp],
  ['a4', 'AWS_SESSION_TOKEN='+['Q','R','S'].map(c=>'sk'+'-'+c.repeat(16)).join('\n')+' public'],
  ['budget', 'ordinary '.repeat(10000)+'sk'+'-'+'Q'.repeat(16)],
  ['budget-vendor', 'ordinary '.repeat(10000)+'sk'+'-'+'Q'.repeat(16)+' '+pp],
  ['sink-exhaustion', 'note '+pp+' '.repeat(524288)],
] as const;
let seed=0x5eed;
function material(n:number) { let s='';for(let i=0;i<n;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[seed%62];}return s; }
// Child completes a below-floor outer match on the composite original.
export const compositeOuters = [
  ['sk'+'-',16], ['gh'+'p_',20], ['gh'+'o_',20], ['gh'+'u_',20], ['gh'+'s_',20], ['gh'+'r_',20],
  ['github'+'_pat_',20], ['gl'+'pat-',20], ['xox'+'b-',20], ['xapp'+'-1-',20],
  ['AI'+'za',30], ['npm'+'_',20], ['xai'+'-',20], ['gsk'+'_',40], ['hf'+'_',30],
  ['SG'+'.'+'A'.repeat(22)+'.',43], ['py'+'pi-AgE',82], ['Bearer ',12],
  ['Authorization: Basic ',12], ['token=',8], ['?key=',8], ['ey'+'J'+'A'.repeat(9)+'.'+'B'.repeat(12)+'.',8],
] as const;
export const generated = compositeOuters.flatMap(([prefix,floor],outer) =>
  [1, Math.max(1,floor-4)].flatMap(k => vendors.flatMap(([kind,value]) => {
    const head=prefix+material(k);
    return ['-','_','.','/',':','=',''].map((sep,index)=>({
      id:`generated/${outer}/${k}/${kind}/${index}`, text:head+sep+value, outer:head, value,
    }));
  })));
// Include every original lane fixture and placement in the release differential.
const laneValues = [
  'AS'+'IA'+'FAKE'.repeat(4), 'AK'+'IA'+'FAKE'.repeat(4),
  'sec'+'ret_'+'Ab3Cd5Ef7'.repeat(4)+'Gh9Jk2L',
  'nt'+'n_'+'12345678901'+'Ab3Cd5E'.repeat(5),
  'pp'+'lx-'+'a1b2c3d4'.repeat(6),
];
const laneSession='IQ'+'oJb3JpZ2luX2Vj'+'Ab3Cd5Ef7+/'.repeat(28)+'==';
const placements = [
  (v:string)=>`before ${v} after`, (v:string)=>`**Result**: ${v}`,
  (v:string)=>`Use \`${v}\` here`, (v:string)=>`\`\`\`text\n${v}\n\`\`\``,
  (v:string)=>`https://example.invalid/?result=${v}&page=next`,
  (v:string)=>JSON.stringify({result:v}), (v:string)=>`RESULT=${v}`,
];
const laneCorpus=[
  ...[...laneValues,...fields.map(f=>f+'='+laneSession)].flatMap((value,kind)=>[
    ...placements.map((wrap,place)=>({id:`lane/${kind}/${place}`,text:wrap(value)})),
    ...['\n','\r\n'].flatMap((eol,e)=>['','  '].map((indent,i)=>({id:`lane/${kind}/fold/${e}/${i}`,text:value.slice(0,-8)+eol+indent+value.slice(-8)}))),
  ]),
  ...vendors.map(([kind,child])=>({id:'overlap-pypi/'+kind,text:'before '+'py'+'pi-'+'AgE'+'B'.repeat(82)+'-'+child+' after'})),
];
export const corpus = [
  ...laneCorpus,
  ...plainForms.map(({id,text})=>({id:'plain/'+id,text})),
  ...witnesses.map(([id,text])=>({id,text})),
  ...generated.map(({id,text})=>({id,text})),
  ...['ordinary prose', 'token: string', '**token**: ordinary-value', 'prompt="'+'ordinary '.repeat(7)+'"', 'hello\nworld', 'email@example.invalid', 'prefix '+'4111'+' 1111'.repeat(3)].map((text,i)=>({id:'legacy/'+i,text})),
];
