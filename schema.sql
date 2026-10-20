CREATE TABLE catalogs (
  number bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(200) NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  selection_order text NOT NULL,
  process_count integer NOT NULL
);

CREATE TABLE processes (
  catalog_number bigint NOT NULL REFERENCES catalogs ON DELETE CASCADE,
  position integer NOT NULL,
  pid bigint NOT NULL,
  name varchar(260) NOT NULL,
  user_name varchar(256),
  description varchar(10000),
  priority smallint NOT NULL,
  cpu_usage_percent double precision,
  memory_usage_bytes bigint,
  PRIMARY KEY (catalog_number, position),
  UNIQUE (catalog_number, pid)
);
