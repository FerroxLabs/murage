import pathlib,re,sys,xml.etree.ElementTree as E
path=pathlib.Path(sys.argv[1]); text=path.read_text(); ns={'g':'https://schema.gradle.org/dependency-verification'}
r=E.fromstring(text)
comp=r.find(".//g:component[@group='org.gradle.kotlin.kotlin-dsl'][@name='org.gradle.kotlin.kotlin-dsl.gradle.plugin'][@version='6.7.6']",ns)
art=comp.find('g:artifact',ns); assert art is not None
assert art.find('g:pgp',ns) is None
expected=art.find('g:sha256',ns).attrib['value']; assert len(expected)==64
assert text.count(expected)==1
path.write_text(text.replace(expected,'0'*64))
print(art.attrib['name'],expected,'->','0'*64)
