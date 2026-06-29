import { useEffect, useState } from 'react';
import Footer from './components/Footer';
import Header from './components/Header';
import Hero from './components/Hero';
import Newsletter from './components/Newsletter';
import ProductGrid from './components/ProductGrid';
import { type Product, products } from './products';

export default function App() {
  const [cartCount, setCartCount] = useState(0);

  useEffect(() => {
    // BUG: fetch a featured endpoint that does not exist -> 404 network request,
    // and the response is treated as JSON / a property is read off the result,
    // throwing and logging a console error on initial load.
    fetch('/api/featured')
      .then((res) => res.json())
      .then((data) => {
        // `data` is undefined because the request 404s and json() rejects;
        // even when reached, `.featured.length` blows up on undefined.
        console.log('featured count', data.featured.length);
      })
      .catch((err) => {
        console.error('Failed to load featured products', err);
      });
  }, []);

  function addToCart(_product: Product) {
    setCartCount((c) => c + 1);
  }

  function addToCartBroken(product: Product) {
    // BUG: references an undefined variable in the click handler -> throws a
    // ReferenceError that is caught nowhere, surfacing as an uncaught error in
    // the console. The line below never runs, so the cart never updates.
    // @ts-expect-error intentionally referencing an undeclared identifier
    const quantity = quantityToAdd;
    setCartCount((c) => c + quantity);
    console.log('added', product.title);
  }

  return (
    <>
      <Header cartCount={cartCount} />
      <main>
        <Hero />
        <ProductGrid products={products} onAdd={addToCart} onAddBroken={addToCartBroken} />
        <Newsletter />
      </main>
      <Footer />
    </>
  );
}
