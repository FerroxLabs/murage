// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { segmentRows, archiveMatrix } from './no-limits-archive-design-cases.ts';
export const y3bRows: Array<{id:string;command:string;cwd:string;held:boolean;seatX?:boolean}> = [
 ...segmentRows.map(([command,held],i)=>({id:`S1-Q-${i}`,command,cwd:'/w',held})),
 ...archiveMatrix.map(([program,args,,cwd],i)=>({id:`AR-${i}`,command:[program,...args].join(' '),cwd:cwd??'/w',held:false})),
 {id:'C-S1',command:'set --; cd /nope; tar -xf /tmp/a.tar',cwd:'/etc',held:true,seatX:true},
 {id:'C-S1-RUN',command:'set --; cd /nope; tar -xf /tmp/a.tar',cwd:'/w',held:false,seatX:true},
 ...[true,false].flatMap(held=>[
  {id:`CAP-LEN-${held}`,command:'true;'.repeat(14000)+`printf x > ${held?'~/.ssh/config':'./notes'}`,cwd:'/w',held},
  {id:`E-S1-${held}`,command:`set --; find . -exec touch ${held?'~/.ssh/config':'./notes'} \\;`,cwd:'/w',held,seatX:true},
  {id:`P-g-${held}`,command:`set --; chmod -x ${held?'~/.ssh/config':'./notes'}`,cwd:'/w',held,seatX:true},
 ]),
 {id:'FA-CPIO',command:'cpio -idm -D /etc < ./a.cpio',cwd:'/w',held:true},
];
