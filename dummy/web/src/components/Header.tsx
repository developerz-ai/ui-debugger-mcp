import styles from './Header.module.scss';

interface HeaderProps {
  cartCount: number;
}

export default function Header({ cartCount }: HeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        {/* BUG: logo.png does not exist -> 404 network request, broken image icon.
            alt is also missing meaningful text. */}
        <img className={styles.logo} src="/images/logo.png" alt="logo" />
        <span className={styles.wordmark}>Nimbus Store</span>
      </div>
      <nav className={styles.nav}>
        <a href="#shop">Shop</a>
        <a href="#new">New Arrivals</a>
        <a href="#about">About</a>
        <a href="#contact">Contact</a>
      </nav>
      <div className={styles.cart} aria-label="cart">
        <span className={styles.cartIcon}>Cart</span>
        <span className={styles.cartCount} data-testid="cart-count">
          {cartCount}
        </span>
      </div>
    </header>
  );
}
