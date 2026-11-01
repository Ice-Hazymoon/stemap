import { listUsers } from "../../../lib/users";

export async function GET() {
  return Response.json(await listUsers());
}

export const POST = async (req: Request) => Response.json(await req.json());

export const config = { runtime: "nodejs" };
