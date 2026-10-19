-- Disputes exist only from 0105 on (applied with it, before 0106): two LOST disputes, one payment sized by its refund operation, one unsized.
INSERT INTO payment_disputes (dispute_id,home_id,charge_id,invoice_id,scope,opened_at,closed_at,outcome,returned_cents) VALUES
 ('dp8','h1','ch8','in_8','current',1,2,'lost',4900), ('dp9','h1','ch9','in_9','current',1,2,'lost',4900);
