// drizzle-orm 0.45 的 pg-core 没有内置 bytea 列类型，用 customType 表达；驱动层 node-postgres 原生以 Buffer 收发。
import { customType } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
