import { coreCall } from "../../native/src/index.ts";
const schema = coreCall<{ version: number; sql: string }>("store.schema", null);
export const schemaVersion = schema.version;
export const initialSchema = schema.sql;
