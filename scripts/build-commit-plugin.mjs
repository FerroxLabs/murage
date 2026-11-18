// The package gate reads this exact build-time stamp, never an operator label.
export function buildCommitPlugin(commit) {
 return { name: 'murage-build-commit', apply: 'build', generateBundle() {
  this.emitFile({type:'asset',fileName:'build-commit.json',source:JSON.stringify({commit})+'\n'});
 }};
}
