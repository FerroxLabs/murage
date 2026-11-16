import hashlib
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('java',pathlib.Path(__file__).with_name('signal-java-inputs.py'))
java=importlib.util.module_from_spec(spec);spec.loader.exec_module(java)
class JavaAuthentication(unittest.TestCase):
    def test_authentication_witnesses(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);archive=root/'java.tar.gz';checksum=root/'checksum';signature=root/'signature'
            archive.write_bytes(b'synthetic archive');checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest());signature.write_text('synthetic signature boundary')
            pin={'sha256':checksum.read_text()}
            good=lambda *a,**kw: subprocess.CompletedProcess(a,0,'[GNUPG:] VALIDSIG '+java.FINGERPRINT+'\n')
            java.authenticate(archive,pin,checksum,signature,['gpg'],good)
            archive.write_bytes(b'flipped archive')
            with self.assertRaisesRegex(ValueError,'archive hash'):java.authenticate(archive,pin,checksum,signature,['gpg'],good)
            archive.write_bytes(b'synthetic archive');checksum.write_text('0'*64)
            with self.assertRaisesRegex(ValueError,'published|Published'):java.authenticate(archive,pin,checksum,signature,['gpg'],good)
            checksum.write_text(pin['sha256'])
            bad=lambda *a,**kw: subprocess.CompletedProcess(a,0,'[GNUPG:] VALIDSIG '+'0'*40+'\n')
            with self.assertRaisesRegex(ValueError,'signer'):java.authenticate(archive,pin,checksum,signature,['gpg'],bad)
            def failed(*a,**kw):raise subprocess.CalledProcessError(1,a)
            with self.assertRaises(subprocess.CalledProcessError):java.authenticate(archive,pin,checksum,signature,['gpg'],failed)
if __name__=='__main__':unittest.main()
