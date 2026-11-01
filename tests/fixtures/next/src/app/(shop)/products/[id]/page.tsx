export default function Product({ params }: { params: { id: string } }) {
  return <h1>{params.id}</h1>;
}
