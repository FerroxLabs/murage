// SPDX-License-Identifier: AGPL-3.0-or-later
// This fake engine writes only inside launchVerificationServer's isolated home.
// Its item.started events need the same host filesystem observation as a local
// builtin driver. No provider-supplied provenance grants that authority.
export const finalWipeFilesystemFixture = `
 if(url.endsWith('/server/outside-wire.ts')){
  const result=next(url,ctx),source=String(result.source);
  const anchor='const LOCAL_FILESYSTEM_DRIVERS = new Set([';
  if(!source.includes(anchor))throw Error('local filesystem fixture anchor changed');
  return {...result,source:source.replace(anchor,anchor+'"fakeLateTerminal",')};
 }
`;
