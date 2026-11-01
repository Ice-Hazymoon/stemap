import type { EntityKind } from "@/lib/api";

export const LANE_NAME: Record<string, string> = { user: "User", page: "Page", api: "API", service: "Service", database: "Database", queue: "Queue", external: "External" };
export const KIND_NAME: Record<EntityKind, string> = { journey: "Flow", step: "Step", module: "Module", file: "File", fn: "Function", table: "Table", route: "Route", page: "Page", queue: "Queue" };
export const KIND_ZH: Record<EntityKind, string> = { journey: "流程", step: "步骤", module: "模块", file: "文件", fn: "函数", table: "表", route: "路由", page: "页面", queue: "队列" };
export const LANE_ZH: Record<string, string> = { user: "用户", page: "页面", api: "接口", service: "服务", database: "数据库", queue: "队列", external: "外部系统" };
