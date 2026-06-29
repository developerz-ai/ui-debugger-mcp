import styles from './Newsletter.module.scss';

export default function Newsletter() {
  return (
    <section className={styles.newsletter} id="contact">
      <h2 className={styles.heading}>Join the Nimbus list</h2>
      <p className={styles.copy}>Get early access to drops and 10% off your first order.</p>
      {/* BUG: the form has no onSubmit handler and the button is type="submit"
          with no preventDefault -> submitting reloads the page and nothing is
          actually saved. */}
      <form className={styles.form}>
        <input
          className={styles.input}
          type="email"
          name="email"
          placeholder="you@example.com"
          aria-label="email address"
        />
        <button className={styles.submit} type="submit">
          Subscribe
        </button>
      </form>
    </section>
  );
}
