import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function signup(name: string) {
  await prisma.user.create({ data: { name } });
  return prisma.user.findMany();
}

export async function publish(id: number) {
  return prisma.$transaction(async (tx) => {
    await tx.post.update({ where: { id }, data: {} });
    await tx.user.deleteMany();
  });
}

export function outside(tx: { post: { delete(a: unknown): void } }) {
  tx.post.delete({});
}

export class Repo {
  constructor(private prisma: PrismaClient) {}
  save() {
    return this.prisma.post.upsert({ where: { id: 1 }, create: {}, update: {} });
  }
}
