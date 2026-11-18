import {expect} from 'vitest';
export const marker=/«redacted(?: \d+ chars| private key| provider credentials)?»|\[(?:removed|redacted(?:-[a-z]+)?|secret|email|link|number|phone)\]/g;
export function monotone(before:string,after:string,baseFormatting=false) {
  const pieces=(s:string)=>s.split(marker).map(p=>baseFormatting?p.replace(/\s/g,''):p);
  const visible=pieces(before);let part=0,offset=0;
  for(const fragment of pieces(after).filter(Boolean)) {
    while(part<visible.length) {const at=visible[part]!.indexOf(fragment,offset);if(at>=0){offset=at+fragment.length;break;}part++;offset=0;}
    expect(part,'new output reveals material outside the base visible pieces').toBeLessThan(visible.length);
  }
}
