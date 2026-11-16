// Inert inputs for the isolated fake engine; no database command executes.
const row=(id,tool,input,card=true)=>({id:'truly-review-r5-'+id,actor:'owner',level:'unlimited',tool,input,expected:card?'CARD':'RUN',expectedCards:card?1:0});
export const sqlR5Rows=[
 row('comment-drop','Bash',{command:"psql -c 'DROP/**/TABLE fixture'"}),
 row('grouped-query','node',{code:'(db.query)("DROP TABLE fixture")'}),
 row('grouped-mongo','node',{code:'(db.x.deleteMany)({})'}),
 row('current-user','Bash',{command:`psql -c "DELETE FROM t WHERE CURRENT_USER <> ''"`}),
 row('grouped-execute','python',{code:'(cursor.execute)(sql)'}),
 row('aliased-query','node',{code:'const q=db.query; q(sql)'}),
 row('now','Bash',{command:`psql -c "DELETE FROM t WHERE now() > '2000-01-01'"`}),
 row('constant-in','Bash',{command:"psql -c 'DELETE FROM t WHERE 1 IN (1)'"}),
 row('substring','node',{code:'db.query("SELECT dropped FROM t")'}),
 row('select','Bash',{command:"psql -c 'SELECT * FROM t;'"},false),
 row('update','Bash',{command:"psql -c 'UPDATE t SET a=1 WHERE id=5;'"},false),
 // MAIN RULING T6: bounded DELETE is executable SQL and retains its card.
 row('delete-id','Bash',{command:"psql -c 'DELETE FROM t WHERE id=5;'"},true),
 // MAIN RULING T6: bounded DELETE is executable SQL and retains its card.
 row('delete-in','Bash',{command:`psql -c "DELETE FROM t WHERE email IN ('a@x.com','b@x.com')"`},true),
];
export const sqlR5McpRows=[
 row('mcp-comment-drop','mcp__fixture__execute_sql',{query:'DROP/**/TABLE fixture'}),
 row('mcp-current-user','mcp__fixture__execute_sql',{query:"DELETE FROM t WHERE CURRENT_USER <> ''"}),
 row('mcp-select','mcp__fixture__execute_sql',{query:'SELECT * FROM t;'},false),
 // MAIN RULING T6: bounded DELETE is executable SQL and retains its card.
 row('mcp-delete-id','mcp__fixture__execute_sql',{query:'DELETE FROM t WHERE id=5;'},true),
 // MAIN RULING T6: bounded DELETE is executable SQL and retains its card.
 row('mcp-delete-in','mcp__fixture__execute_sql',{query:"DELETE FROM t WHERE email IN ('a@x.com','b@x.com')"},true),
];
