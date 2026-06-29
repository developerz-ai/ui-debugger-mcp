import type { Product } from '../products';
import styles from './ProductCard.module.scss';

interface ProductCardProps {
  product: Product;
  // When undefined, the button is rendered without an onClick handler.
  onAdd?: () => void;
}

export default function ProductCard({ product, onAdd }: ProductCardProps) {
  return (
    <article className={styles.card}>
      <div className={styles.media}>
        <img className={styles.image} src={product.image} alt={product.alt} loading="lazy" />
      </div>
      <h3 className={styles.title}>{product.title}</h3>
      <p className={styles.description}>{product.description}</p>
      <div className={styles.row}>
        <span className={styles.price}>${product.price.toFixed(2)}</span>
        {/* BUG (product 3): onAdd is undefined here, so this button has no
            onClick handler -- clicking it never changes the cart count. */}
        <button className={styles.add} onClick={onAdd}>
          Add to cart
        </button>
      </div>
    </article>
  );
}
