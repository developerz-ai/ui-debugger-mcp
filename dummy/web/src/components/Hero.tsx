import styles from './Hero.module.scss';

export default function Hero() {
  return (
    <section className={styles.hero} id="new">
      <div className={styles.inner}>
        <h1 className={styles.title}>Gear that rises above the clouds</h1>
        {/* BUG: subtitle text is white (#fff) on a near-white hero background.
            The copy is in the DOM but invisible to the eye. */}
        <p className={styles.subtitle}>
          Hand-picked tech and lifestyle essentials, shipped carbon-neutral and backed by a 2-year
          warranty. Discover the new spring collection today.
        </p>
        <button className={styles.cta}>Shop the collection</button>
      </div>
    </section>
  );
}
