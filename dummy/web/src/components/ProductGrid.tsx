import type { Product } from '../products';
import ProductCard from './ProductCard';
import styles from './ProductGrid.module.scss';

interface ProductGridProps {
  products: Product[];
  onAdd: (product: Product) => void;
  onAddBroken: (product: Product) => void;
}

export default function ProductGrid({ products, onAdd, onAddBroken }: ProductGridProps) {
  return (
    <section className={styles.section} id="shop">
      {/* BUG: long heading set on a narrow fixed-width container -> overflows. */}
      <h2 className={styles.heading}>Featured products from the spring collection</h2>
      <div className={styles.grid}>
        {products.map((product) => {
          // product 3: no handler wired (forgotten).
          if (product.id === 3) {
            return <ProductCard key={product.id} product={product} />;
          }
          // product 4: handler throws a runtime ReferenceError on click.
          if (product.id === 4) {
            return (
              <ProductCard key={product.id} product={product} onAdd={() => onAddBroken(product)} />
            );
          }
          return <ProductCard key={product.id} product={product} onAdd={() => onAdd(product)} />;
        })}
      </div>
    </section>
  );
}
