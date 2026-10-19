-- INTEGRATED-10: a POPULATED 0101-era database for the 0102 -> 0103 -> 0105 -> 0106 migration test (test/integrated-10-migration.test.ts).
-- A = 10000000 microcents per grant, paid 4900 cents.
INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,status,reversal_state,reversal_reason,reversal_attempts,reversal_last_attempt_at,attempts,claim_id,claimed_at,created_at) VALUES
 ('g1_delivered','k1','h1','in_1','starter',10000000,0,1,5,'done','none',NULL,0,NULL,1,NULL,NULL,100),
 ('g2_confirmed','k2','h1','in_2','starter',10000000,0,1,5,'reversed','done','refund',1,200,1,NULL,NULL,100),
 ('g3_unconfirmed','k3','h1','in_3','starter',10000000,0,1,5,'done','done','refund',2,300,1,NULL,NULL,100),
 ('g4_folded','k4','h1','in_4','starter',10000000,0,1,5,'done','done','stop',0,NULL,1,NULL,NULL,100),
 ('g5_claim','k5','h1','in_5','starter',10000000,0,1,5,'pending','none',NULL,0,NULL,1,'tok5',150,100),
 ('g6_expired_debt','k6','h1','in_6','starter',10000000,0,1,5,'expired','none',NULL,0,NULL,0,NULL,NULL,100),
 ('g7_cancelled','k7','h1','in_7','starter',10000000,0,1,5,'cancelled','none',NULL,0,NULL,0,NULL,NULL,100),
 ('g8_lost_ops','k8','h1','in_8','starter',10000000,0,1,5,'done','none',NULL,0,NULL,1,NULL,NULL,100),
 ('g9_lost_unsized','k9','h1','in_9','starter',10000000,0,1,5,'done','none',NULL,0,NULL,1,NULL,NULL,100),
 ('g10_claim_and_revoke','k10','h1','in_10','starter',10000000,0,1,5,'pending','requested','refund',1,400,1,'tok10',160,100);
INSERT INTO refund_coverage (home_id,payment_intent,invoice_id,subscription_id,paid_cents,covered_cents,open_cents,end_plan,changed_at,created_at) VALUES
 ('h1','pi_2','in_2','sub',4900,4900,0,0,1,1), ('h1','pi_3','in_3','sub',4900,4900,0,0,1,1), ('h1','pi_6','in_6','sub',4900,1000,0,0,1,1);
INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,end_plan,created_at,updated_at) VALUES ('op8','first_month','h1','u1','in_8',4900,0,1,1);
INSERT INTO cloud_payment_inbox (id,home_id,version,payload,received_at,processed_at) VALUES
 ('ev_c1','h1',300,'{"eventId":"ev_c1","homeId":"h1","version":300,"status":"canceled","paymentId":"in_1","subscriptionId":"sub_a"}',10,20),
 ('ev_c2','h2',310,'{"eventId":"ev_c2","homeId":"h2","version":310,"status":"canceled","paymentId":"in_x"}',10,21),
 ('ev_c3','h3',320,'{"eventId":"ev_c3","homeId":"h3","version":320,"status":"canceled","paymentId":"in_y"}',10,NULL),
 ('ev_p1','h1',200,'{"eventId":"ev_p1","homeId":"h1","version":200,"status":"paid","paymentId":"in_1"}',10,15);
