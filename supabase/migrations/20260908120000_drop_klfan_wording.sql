-- 畫面上不再出現「KLFAN」字樣。資料是從哪搬過來的屬於來源註記，寫在 source_note
-- 跟 README 就好，展開的明細裡不用給屋主看。
update public.loan_schedule
set note = '開辦費'
where note = '開辦費（KLFAN 紀錄）';
