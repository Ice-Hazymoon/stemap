import axios from "axios";

export async function loadUsers() {
  const res = await fetch("/api/users");
  return res.json();
}

export function createUser(body: unknown) {
  return axios.post("/api/users", body);
}
