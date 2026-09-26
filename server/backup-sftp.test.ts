// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { resticSftpRepository,resticSftpTargetSchema,sftpFolderSchema,sftpHostSchema,sftpUserSchema,type ResticSftpTarget } from "./backup-restic-target.ts";
import { checkedHostKey,chooseScannedHostKey,classifySshFailure,createSshKeyPair,knownHostsLine,resolveSshTools,resticSftpCommandOption,sftpSshArguments,sshFingerprint,sweepSshMaterial,writeSshMaterial } from "./backup-sftp.ts";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))safeWipeSync(root);});
const scratch=()=>{const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-sftp-unit-")));roots.push(root);return root;};
// A real ed25519 host key blob (type string + 32 bytes), so type checks pass.
const blob=(type:string,body=Buffer.alloc(32,7))=>{const name=Buffer.from(type),length=Buffer.alloc(4);length.writeUInt32BE(name.length);const bodyLength=Buffer.alloc(4);bodyLength.writeUInt32BE(body.length);return Buffer.concat([length,name,bodyLength,body]).toString("base64");};
const hostKey={type:"ssh-ed25519" as const,key:blob("ssh-ed25519")};
const target:ResticSftpTarget={kind:"sftp",remoteRef:"remote-one",revision:3,credentialRef:"key-one",host:"nas.example.com",port:2222,user:"backup",folder:"murage/backups",hostKey};

describe("SFTP destination fields cannot become ssh options",()=>{
  it("accepts ordinary names, addresses and folders",()=>{
    for(const host of ["nas.example.com","192.168.1.20","my-nas","::1","fe80::1:2","a.b-c.d"])expect(sftpHostSchema.safeParse(host).success,host).toBe(true);
    for(const user of ["backup","sean.d","user_1","Admin-2"])expect(sftpUserSchema.safeParse(user).success,user).toBe(true);
    for(const folder of ["murage","murage/backups","/volume1/homes/backup/murage","/srv/restic-repo","backups/2026.09"])expect(sftpFolderSchema.safeParse(folder).success,folder).toBe(true);
  });
  it("rejects leading dashes, whitespace, quotes, control characters and path escapes",()=>{
    for(const host of ["-oProxyCommand=touch /tmp/x","nas example.com","nas\nexample","nas.example.com ","'nas'","\"nas\"","nas;id","nas$(id)","user@nas","-p","nas:22","[::1]","","a".repeat(254),"nas.-bad","nas\u0000"])expect(sftpHostSchema.safeParse(host).success,JSON.stringify(host)).toBe(false);
    for(const user of ["-oProxyCommand=x","-l","back up","user\n","user@host","user;id","\"user\"","","a".repeat(65),"user\\x"])expect(sftpUserSchema.safeParse(user).success,JSON.stringify(user)).toBe(false);
    for(const folder of ["../outside","a/../b","./a","a//b","-rf","a/-x","my backups","a\nb","a\"b","'a'","a;b","~/a","a/b/","/","","a\\b","a/.."])expect(sftpFolderSchema.safeParse(folder).success,JSON.stringify(folder)).toBe(false);
    for(const port of [0,65536,-1,22.5,Number.NaN])expect(resticSftpTargetSchema.safeParse({...target,port}).success).toBe(false);
    expect(resticSftpTargetSchema.safeParse({...target,extra:"-oProxyCommand=x"}).success).toBe(false);
  });
});

describe("ssh argument vector",()=>{
  const files={identityFile:"/private/control/remote/remote-one/3/ssh-abc123/key",knownHostsFile:"/private/control/remote/remote-one/3/ssh-abc123/known_hosts"};
  it("uses only Murage's key and the pinned identity, never config, agent, forwarding or passwords",()=>{
    const args=sftpSshArguments(target,files);
    expect(args.slice(0,2)).toEqual(["-F","none"]);
    const options=args.flatMap((arg,index)=>args[index-1]==="-o"?[arg]:[]);
    for(const required of ["BatchMode=yes","IdentitiesOnly=yes",`IdentityFile='${files.identityFile}'`,"IdentityAgent=none","PasswordAuthentication=no","KbdInteractiveAuthentication=no","PreferredAuthentications=publickey","StrictHostKeyChecking=yes",`UserKnownHostsFile='${files.knownHostsFile}'`,`GlobalKnownHostsFile='${files.knownHostsFile}'`,"HostKeyAlias=murage-backup-server","HostKeyAlgorithms=ssh-ed25519","UpdateHostKeys=no","ForwardAgent=no","ForwardX11=no","ClearAllForwardings=yes","PermitLocalCommand=no","ProxyCommand=none","ControlMaster=no"])expect(options).toContain(required);
    // Destination last, after "--", so nothing in it can be read as an option.
    expect(args.slice(-8)).toEqual(["-p","2222","-l","backup","-s","--","nas.example.com","sftp"]);
    expect(args.filter(arg=>arg.startsWith("-")&&!["-F","-o","-p","-l","-s","--"].includes(arg))).toEqual([]);
  });
  it("refuses to build a command without a pinned identity or with unusual paths",()=>{
    const {hostKey:_unpinned,...unpinned}=target;
    expect(()=>sftpSshArguments(unpinned,files)).toThrow("HOST_KEY_REQUIRED");
    for(const identityFile of ["relative/key","/a\"b/key","/a\nb/key","/a'b/key","C:\\Users\\O'Neil\\key"])expect(()=>sftpSshArguments(target,{...files,identityFile})).toThrow("MATERIAL_INVALID");
    expect(()=>sftpSshArguments({...target,host:"-oProxyCommand=x"},files)).toThrow();
  });
  it("paths with spaces stay one ssh argument (Windows profile folders), and real ssh reads them back",()=>{
    const spaced={identityFile:"C:\\Users\\Sam Lee\\AppData\\Local\\control\\ssh-abc123\\key",knownHostsFile:"/Users/Sam Lee/control/ssh-abc123/known_hosts"};
    const args=sftpSshArguments(target,spaced);
    expect(args).toContain("IdentityFile='C:\\Users\\Sam Lee\\AppData\\Local\\control\\ssh-abc123\\key'");
    expect(args).toContain("UserKnownHostsFile='/Users/Sam Lee/control/ssh-abc123/known_hosts'");
    if(existsSync("/usr/bin/ssh")){
      const posix={identityFile:"/tmp/a b/key",knownHostsFile:"/tmp/c d/known_hosts"},opts=sftpSshArguments(target,posix);
      const config=execFileSync("/usr/bin/ssh",["-G",...opts.slice(0,opts.indexOf("-s"))," nas.example.com".trim()],{encoding:"utf8"});
      expect(config).toMatch(/^identityfile \/tmp\/a b\/key$/m);expect(config).toMatch(/^userknownhostsfile \/tmp\/c d\/known_hosts$/m);expect(config).toMatch(/^stricthostkeychecking true$/m);
    }
  });
  it("Windows children get SystemRoot, ProgramData and a private temp folder, nothing else from Murage",async()=>{
    const {windowsChildEnvironment}=await import("./backup-sftp.ts");
    expect(windowsChildEnvironment("C:\\w",{SystemRoot:"C:\\Windows",ProgramData:"C:\\ProgramData",APPDATA:"C:\\x",FLUX_API_KEY:"secret"})).toEqual({TMP:"C:\\w",TEMP:"C:\\w",USERPROFILE:"C:\\w",SystemRoot:"C:\\Windows",ProgramData:"C:\\ProgramData"});
    expect(windowsChildEnvironment("C:\\w",{SystemRoot:"relative",ProgramData:"C:\\a\"b"})).toEqual({TMP:"C:\\w",TEMP:"C:\\w",USERPROFILE:"C:\\w"});
  });
  it("RSA pins negotiate only RSA signatures",()=>{
    const rsa={type:"ssh-rsa" as const,key:blob("ssh-rsa",Buffer.alloc(64,3))};
    expect(sftpSshArguments({...target,hostKey:rsa},files)).toContain("HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256");
  });
  it("restic receives one CSV-quoted sftp.command with every word double-quoted",()=>{
    const option=resticSftpCommandOption("/usr/bin/ssh",["-p","22","--","host","sftp"]);
    expect(option).toBe('"sftp.command=""/usr/bin/ssh"" ""-p"" ""22"" ""--"" ""host"" ""sftp"""');
    expect(resticSftpCommandOption("C:\\Windows\\System32\\OpenSSH\\ssh.exe",["-F","none"])).toContain('""C:\\Windows\\System32\\OpenSSH\\ssh.exe""');
    expect(()=>resticSftpCommandOption("/usr/bin/ssh",['a"b'])).toThrow("MATERIAL_INVALID");
    expect(()=>resticSftpCommandOption("ssh",["-p"])).toThrow("MATERIAL_INVALID");
    expect(resticSftpRepository(target)).toBe("sftp:murage-backup-server:murage/backups");
  });
});

describe("server identity",()=>{
  it("fingerprints like OpenSSH and pins one alias line",()=>{
    const root=scratch();
    if(existsSync("/usr/bin/ssh-keygen")){
      execFileSync("/usr/bin/ssh-keygen",["-q","-t","ed25519","-N","","-f",join(root,"host")]);
      const key=readFileSync(join(root,"host.pub"),"utf8").split(" ")[1];
      expect(sshFingerprint(key)).toBe(execFileSync("/usr/bin/ssh-keygen",["-lf",join(root,"host.pub")],{encoding:"utf8"}).split(" ")[1]);
    }
    expect(knownHostsLine(hostKey)).toBe(`murage-backup-server ssh-ed25519 ${hostKey.key}\n`);
  });
  it("chooses ed25519 first, ignores comments and rejects a blob that names another type",()=>{
    const rsa=blob("ssh-rsa",Buffer.alloc(64,1)),ecdsa=blob("ecdsa-sha2-nistp256",Buffer.alloc(40,2));
    const output=`# nas:22 SSH-2.0-OpenSSH_9.6\n[nas]:2222 ssh-rsa ${rsa}\n[nas]:2222 ecdsa-sha2-nistp256 ${ecdsa}\n[nas]:2222 ssh-ed25519 ${hostKey.key}\n`;
    expect(chooseScannedHostKey(output)).toEqual(hostKey);
    expect(chooseScannedHostKey(`nas ssh-rsa ${rsa}\nnas ecdsa-sha2-nistp256 ${ecdsa}\n`).type).toBe("ecdsa-sha2-nistp256");
    expect(()=>chooseScannedHostKey("")).toThrow("UNREACHABLE");
    expect(()=>chooseScannedHostKey(`nas ssh-ed25519 ${rsa}\n`)).toThrow("UNREACHABLE");
    expect(()=>checkedHostKey({type:"ssh-ed25519",key:rsa})).toThrow("HOST_KEY_INVALID");
    expect(()=>chooseScannedHostKey(`nas ssh-ed25519 ${hostKey.key}\nnas ssh-ed25519 ${blob("ssh-ed25519",Buffer.alloc(32,9))}\n`)).toThrow("HOST_KEY_INVALID");
  });
  it("reads ssh's refusal text as a code",()=>{
    expect(classifySshFailure("@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@\nHost key verification failed.")).toBe("RESTIC_SFTP_HOST_KEY_CHANGED");
    expect(classifySshFailure("Unable to negotiate with 1.2.3.4 port 22: no matching host key type found.")).toBe("RESTIC_SFTP_HOST_KEY_CHANGED");
    expect(classifySshFailure("backup@nas: Permission denied (publickey).")).toBe("RESTIC_SFTP_KEY_REFUSED");
    expect(classifySshFailure("subsystem request failed on channel 0")).toBe("RESTIC_SFTP_UNAVAILABLE");
    expect(classifySshFailure("ssh: connect to host nas port 22: Connection refused")).toBe("RESTIC_SFTP_UNREACHABLE");
  });
});

describe("Murage's own key",()=>{
  it("is a valid unencrypted OpenSSH ed25519 key with a fixed comment",()=>{
    const pair=createSshKeyPair(),other=createSshKeyPair();
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+={0,2} murage-backup$/);
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);expect(pair.publicKey).not.toBe(other.publicKey);
    if(existsSync("/usr/bin/ssh-keygen")){
      const root=scratch(),file=join(root,"key");writeFileSync(file,pair.privateKey,{mode:0o600});
      expect(execFileSync("/usr/bin/ssh-keygen",["-y","-f",file],{encoding:"utf8"}).trim()).toBe(pair.publicKey);
    }
  });
  it("touches disk only as 0600 files in a fresh 0700 folder, removed afterwards",()=>{
    const root=scratch(),pair=createSshKeyPair(),material=writeSshMaterial(root,target,pair);
    expect(readFileSync(material.identityFile,"utf8")).toBe(pair.privateKey);expect(readFileSync(material.knownHostsFile,"utf8")).toBe(knownHostsLine(hostKey));
    if(process.platform!=="win32"){expect(statSync(material.identityFile).mode&0o777).toBe(0o600);expect(statSync(material.knownHostsFile).mode&0o777).toBe(0o600);expect(statSync(join(material.identityFile,"..")).mode&0o777).toBe(0o700);}
    material.cleanup();expect(readdirSync(root)).toEqual([]);
    // A killed run's folder is swept; other names are left alone.
    const leftover=writeSshMaterial(root,target,pair);mkdirSync(join(root,"keep-me"));writeFileSync(join(root,"restic-target.json"),"{}");
    sweepSshMaterial(root);expect(existsSync(leftover.identityFile)).toBe(false);expect(readdirSync(root).sort()).toEqual(["keep-me","restic-target.json"]);
  });
});

describe("ssh tool lookup never uses PATH",()=>{
  it("Windows uses the built-in OpenSSH client and says how to add it when missing",()=>{
    const asked:string[]=[];
    expect(resolveSshTools("win32",file=>{asked.push(file);return true;})).toEqual({ssh:"C:\\Windows\\System32\\OpenSSH\\ssh.exe",keyscan:"C:\\Windows\\System32\\OpenSSH\\ssh-keyscan.exe"});
    expect(asked.every(file=>/^C:\\Windows\\System32\\OpenSSH\\/.test(file))).toBe(true);
    expect(()=>resolveSshTools("win32",()=>false)).toThrow("RESTIC_SFTP_SSH_MISSING_WINDOWS");
  });
  it("macOS and Linux use absolute system paths",()=>{
    expect(resolveSshTools("darwin",()=>true)).toEqual({ssh:"/usr/bin/ssh",keyscan:"/usr/bin/ssh-keyscan"});
    expect(resolveSshTools("linux",file=>file.startsWith("/bin/"))).toEqual({ssh:"/bin/ssh",keyscan:"/bin/ssh-keyscan"});
    expect(()=>resolveSshTools("darwin",()=>false)).toThrow(/^RESTIC_SFTP_SSH_MISSING$/);
    const asked:string[]=[];expect(()=>resolveSshTools("linux",file=>{asked.push(file);return false;})).toThrow("RESTIC_SFTP_SSH_MISSING");
    expect(asked.length).toBeGreaterThan(0);expect(asked.every(file=>file.startsWith("/usr/bin/")||file.startsWith("/bin/"))).toBe(true);
  });
});
