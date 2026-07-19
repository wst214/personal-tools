-- PERF schema init (DM8). Requires DMGEO2 spatial module on the instance.

-- Enable DMGEO2 only when it has not been initialized.
-- Some DM8 versions return an error when SP_INIT_GEO2_SYS(1) is called twice.
DECLARE
    v_cnt INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
      FROM SYS.SYSOBJECTS
     WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH';
    IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CALL SP_INIT_GEO2_SYS(1)';
    END IF;
END;
/

-- Fail fast when spatial module is not installed
DECLARE
    v_cnt INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
      FROM SYS.SYSOBJECTS
     WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH';
    IF v_cnt = 0 THEN
        RAISE_APPLICATION_ERROR(
            -20001,
            'DMGEO2 not installed. Install DM8 spatial component on dbserver, then re-run init-schema.'
        );
    END IF;
END;
/

-- Create PERF schema if missing
DECLARE
    v_cnt INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
      FROM SYS.SYSOBJECTS
     WHERE NAME = 'PERF' AND TYPE$ = 'SCH';
    IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE SCHEMA "PERF" AUTHORIZATION LEIDIAN_APP';
    END IF;
END;
/

ALTER SESSION SET CURRENT_SCHEMA = "PERF";
