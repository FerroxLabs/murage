Captured read-only on a real Windows 11 (build 26200) machine on 2026-10-21 from test processes and folders created for the capture
(a node.exe sleeper, a temp folder). Names and SIDs of the machine and its account are replaced with test values; the shapes are untouched.
native-sleeper.json  engine-exclusion.node processes() entry for the sleeper
tasklist.csv         tasklist /FO CSV /NH, three rows
netstat.txt          netstat -ano -p tcp, header and the listening rows of interest
icacls-*.txt         icacls <path> /save <file> /q, decoded from UTF-16LE
