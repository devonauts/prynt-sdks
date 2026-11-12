<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Prynt Reveal — B2B visitor identification (which companies visit the site).
 *
 * Independent of the Device protection: it only needs the website's PUBLIC key and domain, which the
 * site owner gets in one of two ways from the Prynt console (Reveal → quick start → WordPress):
 *   - "Connect": paste the one-time setup code (ABCD-EFGH, valid 30 minutes, single use); the plugin
 *     exchanges it server-side at GET {endpoint}/v1/reveal/setup/{code} for {publicKey, website};
 *   - or paste the public key (pk_live_…) and the domain by hand.
 * Once set, the Reveal-only bundle (prynt-reveal.umd.js, global PryntReveal) loads in <head> on every
 * front-end page. The first visit verifies the website automatically — no DNS record or meta tag.
 */
class Prynt_Reveal {

	const KEY_RX = '/^pk_(live|test|staging)_[A-Za-z0-9]{8,64}$/';

	public function __construct() {
		add_action( 'admin_init', array( $this, 'maybe_save' ) );
		if ( self::configured() ) {
			add_action( 'wp_enqueue_scripts', array( $this, 'enqueue' ), 1 );
		}
	}

	public static function configured() {
		$s = prynt_get_settings();
		return ! empty( $s['reveal_public_key'] ) && ! empty( $s['reveal_website'] );
	}

	/** Front-end only (never wp-admin / login): the snippet the console shows, as a proper enqueue. */
	public function enqueue() {
		$s   = prynt_get_settings();
		$src = trailingslashit( $s['endpoint'] ) . 'cdn/prynt-reveal.umd.js';
		// In <head>, async (WP 6.3+ honours `strategy`; older versions load it in the footer — still fine).
		wp_enqueue_script( 'prynt-reveal', $src, array(), null, array( 'in_footer' => false, 'strategy' => 'async' ) );
		$opts = wp_json_encode( array( 'publicKey' => $s['reveal_public_key'], 'website' => $s['reveal_website'] ) );
		// A separate inline handle (an "after" inline script would make WordPress drop the async strategy):
		// it waits for the async bundle's global, at most ~10 s.
		$inline = '(function(o,n){function go(){if(window.PryntReveal){window.PryntReveal.reveal(o);}else if(n-->0){setTimeout(go,100);}}go();})(' . $opts . ',100);';
		wp_register_script( 'prynt-reveal-init', false, array(), PRYNT_VERSION, false );
		wp_enqueue_script( 'prynt-reveal-init' );
		wp_add_inline_script( 'prynt-reveal-init', $inline );
	}

	/** Normalise "https://www.acme.com/x" → "acme.com" (the console strips www. the same way). */
	public static function domain( $value ) {
		$v = strtolower( trim( (string) $value ) );
		$v = preg_replace( '#^[a-z]+://#', '', $v );
		$v = preg_replace( '#[/?\#:].*$#', '', $v );
		$v = preg_replace( '/^www\./', '', $v );
		return preg_match( '/^[a-z0-9.-]{1,253}\.[a-z]{2,63}$/', $v ) ? $v : '';
	}

	/** Exchange a one-time setup code → array( ok, message ). */
	private function connect( $code ) {
		$s    = prynt_get_settings();
		$code = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) $code ) );
		if ( strlen( $code ) !== 8 ) {
			return array( false, __( 'The setup code has 8 characters, like ABCD-EFGH.', 'prynt' ) );
		}
		$res = wp_remote_get( trailingslashit( $s['endpoint'] ) . 'v1/reveal/setup/' . rawurlencode( $code ), array( 'timeout' => 8 ) );
		if ( is_wp_error( $res ) ) {
			return array( false, $res->get_error_message() );
		}
		$status = (int) wp_remote_retrieve_response_code( $res );
		$body   = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 200 !== $status || ! is_array( $body ) ) {
			return array( false, 404 === $status
				? __( 'This setup code is unknown, used or expired. Create a new one in the Prynt console.', 'prynt' )
				: sprintf( __( 'Unexpected response (HTTP %d).', 'prynt' ), $status ) );
		}
		$key  = isset( $body['publicKey'] ) ? (string) $body['publicKey'] : '';
		$site = isset( $body['website'] ) ? self::domain( $body['website'] ) : '';
		if ( ! preg_match( self::KEY_RX, $key ) || '' === $site ) {
			return array( false, __( 'The response did not contain a valid key.', 'prynt' ) );
		}
		$this->store( $key, $site );
		return array( true, sprintf( __( 'Connected: Reveal is live on %s. Open your site once to verify it.', 'prynt' ), $site ) );
	}

	private function store( $key, $site ) {
		$s                       = prynt_get_settings();
		$s['reveal_public_key']  = $key;
		$s['reveal_website']     = $site;
		update_option( PRYNT_OPTION, $s );
	}

	public function maybe_save() {
		if ( ! isset( $_POST['prynt_reveal_nonce'] ) || ! current_user_can( 'manage_options' ) ) { return; }
		if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['prynt_reveal_nonce'] ) ), 'prynt_reveal' ) ) { return; }
		$in     = wp_unslash( $_POST );
		$action = isset( $in['prynt_reveal_action'] ) ? sanitize_key( $in['prynt_reveal_action'] ) : '';
		if ( 'disconnect' === $action ) {
			$this->store( '', '' );
			add_settings_error( 'prynt', 'reveal', __( 'Reveal disconnected.', 'prynt' ), 'updated' );
			return;
		}
		if ( 'connect' === $action ) {
			list( $ok, $msg ) = $this->connect( isset( $in['reveal_code'] ) ? sanitize_text_field( $in['reveal_code'] ) : '' );
			add_settings_error( 'prynt', 'reveal', $msg, $ok ? 'updated' : 'error' );
			return;
		}
		$key  = isset( $in['reveal_public_key'] ) ? sanitize_text_field( trim( $in['reveal_public_key'] ) ) : '';
		$site = isset( $in['reveal_website'] ) ? self::domain( sanitize_text_field( $in['reveal_website'] ) ) : '';
		if ( ! preg_match( self::KEY_RX, $key ) ) {
			add_settings_error( 'prynt', 'reveal', __( 'Paste the public key (pk_live_…) from the Prynt console — never the secret key.', 'prynt' ), 'error' );
			return;
		}
		if ( '' === $site ) {
			$site = self::domain( home_url() );
		}
		$this->store( $key, $site );
		add_settings_error( 'prynt', 'reveal', sprintf( __( 'Reveal is live on %s.', 'prynt' ), $site ), 'updated' );
	}

	/** The "Reveal" card of the settings page. */
	public static function render_card() {
		$s    = prynt_get_settings();
		$on   = self::configured();
		$site = $s['reveal_website'] ? $s['reveal_website'] : self::domain( home_url() );
		?>
		<div class="prynt-card prynt-reveal">
			<h2><?php esc_html_e( 'Reveal — see which companies visit your site', 'prynt' ); ?></h2>
			<?php if ( $on ) : ?>
				<p class="prynt-status ok"><?php echo esc_html( sprintf( __( 'Live on %1$s with key %2$s…', 'prynt' ), $s['reveal_website'], substr( $s['reveal_public_key'], 0, 14 ) ) ); ?></p>
				<p class="hint"><?php esc_html_e( 'The first visit verifies the website automatically. Companies appear in the Prynt console under Reveal.', 'prynt' ); ?></p>
				<form method="post">
					<?php wp_nonce_field( 'prynt_reveal', 'prynt_reveal_nonce' ); ?>
					<input type="hidden" name="prynt_reveal_action" value="disconnect" />
					<button type="submit" class="button"><?php esc_html_e( 'Disconnect', 'prynt' ); ?></button>
				</form>
			<?php else : ?>
				<form method="post">
					<?php wp_nonce_field( 'prynt_reveal', 'prynt_reveal_nonce' ); ?>
					<input type="hidden" name="prynt_reveal_action" value="connect" />
					<label><?php esc_html_e( 'Setup code', 'prynt' ); ?>
						<input type="text" name="reveal_code" placeholder="ABCD-EFGH" autocomplete="off" maxlength="12" />
						<span class="hint"><?php echo wp_kses_post( sprintf( __( 'In the <a href="%s" target="_blank" rel="noopener">Prynt console</a>: Reveal → quick start → WordPress → Get a setup code.', 'prynt' ), 'https://app.pryntid.com/reveal/start' ) ); ?></span>
					</label>
					<p><button type="submit" class="button button-primary"><?php esc_html_e( 'Connect', 'prynt' ); ?></button></p>
				</form>
				<details>
					<summary><?php esc_html_e( 'Or paste the public key by hand', 'prynt' ); ?></summary>
					<form method="post">
						<?php wp_nonce_field( 'prynt_reveal', 'prynt_reveal_nonce' ); ?>
						<input type="hidden" name="prynt_reveal_action" value="save" />
						<label><?php esc_html_e( 'Public key', 'prynt' ); ?>
							<input type="text" name="reveal_public_key" placeholder="pk_live_…" autocomplete="off" />
						</label>
						<label><?php esc_html_e( 'Website', 'prynt' ); ?>
							<input type="text" name="reveal_website" value="<?php echo esc_attr( $site ); ?>" />
						</label>
						<p><button type="submit" class="button"><?php esc_html_e( 'Save', 'prynt' ); ?></button></p>
					</form>
				</details>
			<?php endif; ?>
		</div>
		<?php
	}
}
