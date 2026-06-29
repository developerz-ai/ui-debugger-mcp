import styles from './Footer.module.scss';

export default function Footer() {
  return (
    <footer className={styles.footer} id="about">
      <div className={styles.cols}>
        <div>
          <h4>Nimbus Store</h4>
          <p>Gear that rises above the clouds.</p>
        </div>
        <div>
          <h4>Help</h4>
          <a href="#">Shipping</a>
          <a href="#">Returns</a>
          <a href="#">Contact</a>
        </div>
        <div>
          <h4>Company</h4>
          <a href="#">About</a>
          <a href="#">Careers</a>
          <a href="#">Press</a>
        </div>
      </div>
      <p className={styles.legal}>© 2026 Nimbus Store. All rights reserved.</p>
    </footer>
  );
}
