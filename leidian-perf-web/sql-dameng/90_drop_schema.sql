-- Drop PERF schema (reset perf DB). Deletes all objects under PERF.

DECLARE
    v_cnt INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
      FROM SYS.SYSOBJECTS
     WHERE NAME = 'PERF' AND TYPE$ = 'SCH';
    IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP SCHEMA "PERF" CASCADE';
    END IF;
END;
/
