import concurrent.futures, pathlib, subprocess, sys, urllib.error, urllib.request, xml.etree.ElementTree as E
job=pathlib.Path('/job')
out=pathlib.Path('/evidence')
n={'g':'https://schema.gradle.org/dependency-verification'}
r=E.parse(job/'source/gradle/verification-metadata.xml').getroot()
ids=sorted(set([e.attrib['id'] for e in r.findall('.//g:ignored-key',n)+r.findall('.//g:trusted-key',n)]+[e.attrib['value'] for e in r.findall('.//g:pgp',n)]))
home=out/'metadata-gnupg'; home.mkdir(mode=0o700,exist_ok=True)
gpg=['gpg','--homedir',str(home),'--batch','--no-auto-key-retrieve']
def run_gpg(args):
    result=subprocess.run(gpg+args,capture_output=True)
    if result.stderr:
        print(f'GPG {args}: {result.stderr.decode(errors="replace")}',file=sys.stderr,flush=True)
    if result.returncode and result.stdout:
        print(result.stdout.decode(errors='replace'),file=sys.stderr,flush=True)
    # Import/process/storage errors must abort generation, never remove PGP trust.
    result.check_returncode()
    return result
run_gpg(['--import',str(job/'source/gradle/verification-keyring.keys')])
max_key_bytes=2_000_000
def retrieve(key):
    for base in ['https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x','https://keys.openpgp.org/vks/v1/by-keyid/']:
        try:
            with urllib.request.urlopen(base+key,timeout=15) as res: data=res.read(max_key_bytes+1)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as ex:
            print(f'{key}: retrieval failed from {base}: {ex}',file=sys.stderr,flush=True)
            continue
        if len(data)>max_key_bytes:
            raise RuntimeError(f'{key}: response from {base} exceeds {max_key_bytes} bytes')
        # Keep local writes and GPG outside the recoverable network-error handler.
        dest=out/(key+'.asc'); dest.write_bytes(data)
        run_gpg(['--import',str(dest)])
        return key+' imported'
    return key+' unavailable; SHA256 required'
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for line in pool.map(retrieve,ids): print(line,flush=True)
result=run_gpg(['--armor','--export'])
(out/'enriched-keyring.keys').write_bytes(result.stdout)
