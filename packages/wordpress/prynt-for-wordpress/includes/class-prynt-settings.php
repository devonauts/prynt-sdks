<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Admin panel: settings form, connection test, and a recent-activity dashboard.
 */
class Prynt_Settings {

	public function __construct() {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_init', array( $this, 'maybe_save' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'assets' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( PRYNT_FILE ), array( $this, 'action_links' ) );
	}

	public function menu() {
		add_menu_page( 'Prynt', 'Prynt', 'manage_options', 'prynt', array( $this, 'render' ), 'dashicons-shield-alt', 76 );
	}

	public function action_links( $links ) {
		$url = admin_url( 'admin.php?page=prynt' );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'prynt' ) . '</a>' );
		return $links;
	}

	public function assets( $hook ) {
		if ( 'toplevel_page_prynt' !== $hook ) { return; }
		wp_enqueue_style( 'prynt-admin', PRYNT_URL . 'assets/admin.css', array(), PRYNT_VERSION );
	}

	public function maybe_save() {
		if ( ! isset( $_POST['prynt_nonce'] ) || ! current_user_can( 'manage_options' ) ) { return; }
		if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['prynt_nonce'] ) ), 'prynt_save' ) ) { return; }

		$in = wp_unslash( $_POST );
		$out = array(
			'endpoint'             => esc_url_raw( trim( $in['endpoint'] ) ),
			'public_key'           => sanitize_text_field( trim( $in['public_key'] ) ),
			'secret_key'           => sanitize_text_field( trim( $in['secret_key'] ) ),
			'mode'                 => ( isset( $in['mode'] ) && 'block' === $in['mode'] ) ? 'block' : 'monitor',
			'block_score'          => max( 1, min( 100, (int) $in['block_score'] ) ),
			'protect_login'        => empty( $in['protect_login'] ) ? 0 : 1,
			'protect_register'     => empty( $in['protect_register'] ) ? 0 : 1,
			'protect_comments'     => empty( $in['protect_comments'] ) ? 0 : 1,
			'protect_woocommerce'  => empty( $in['protect_woocommerce'] ) ? 0 : 1,
			'expected_scripts'     => sanitize_text_field( trim( isset( $in['expected_scripts'] ) ? $in['expected_scripts'] : 'latin' ) ),
		);
		// Merge over the CURRENT settings so the Reveal connection (its own form) is kept.
		update_option( PRYNT_OPTION, wp_parse_args( $out, prynt_get_settings() ) );
		add_settings_error( 'prynt', 'saved', __( 'Settings saved.', 'prynt' ), 'updated' );
	}

	/** Validate the secret key: hitting an unknown requestId returns 404 when auth is OK, 401 when not. */
	private function test_connection() {
		$s = prynt_get_settings();
		if ( empty( $s['secret_key'] ) ) { return array( false, 'Add a secret key first.' ); }
		$res = wp_remote_get( trailingslashit( $s['endpoint'] ) . 'v1/events/prynt-connection-test', array(
			'timeout' => 5,
			'headers' => array( 'Authorization' => 'Bearer ' . $s['secret_key'] ),
		) );
		if ( is_wp_error( $res ) ) { return array( false, $res->get_error_message() ); }
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( 404 === $code ) { return array( true, 'Connected — secret key is valid.' ); }
		if ( 401 === $code ) { return array( false, 'Secret key rejected (401).' ); }
		return array( false, 'Unexpected response (HTTP ' . $code . ').' );
	}

	public function render() {
		$s = prynt_get_settings();
		$configured = prynt_is_configured();
		$test = null;
		if ( isset( $_GET['prynt_test'] ) && check_admin_referer( 'prynt_test' ) ) {
			$test = $this->test_connection();
		}
		$recent = get_option( 'prynt_recent', array() );
		settings_errors( 'prynt' );
		?>
		<div class="wrap prynt-wrap">
			<h1><span class="dashicons dashicons-shield-alt"></span> Prynt — Device Intelligence</h1>
			<p class="prynt-sub">Identify visitors and block bots &amp; fraud on your key forms, powered by open-source device intelligence.</p>

			<div class="prynt-status <?php echo $configured ? 'ok' : 'warn'; ?>">
				<?php echo $configured
					? esc_html__( 'Active and configured.', 'prynt' )
					: esc_html__( 'Not configured yet — add your API endpoint and public key below.', 'prynt' ); ?>
				<?php if ( $configured ) : ?>
					<a class="button button-small" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin.php?page=prynt&prynt_test=1' ), 'prynt_test' ) ); ?>"><?php esc_html_e( 'Test connection', 'prynt' ); ?></a>
				<?php endif; ?>
			</div>
			<?php if ( $test ) : ?>
				<div class="prynt-test <?php echo $test[0] ? 'ok' : 'bad'; ?>"><?php echo esc_html( $test[1] ); ?></div>
			<?php endif; ?>

			<div class="prynt-grid">
				<form method="post" class="prynt-card">
					<?php wp_nonce_field( 'prynt_save', 'prynt_nonce' ); ?>
					<h2><?php esc_html_e( 'Connection', 'prynt' ); ?></h2>
					<label>API endpoint
						<input type="url" name="endpoint" value="<?php echo esc_attr( $s['endpoint'] ); ?>" placeholder="https://api.pryntid.com" />
						<span class="hint"><?php esc_html_e( 'Your Prynt API base URL.', 'prynt' ); ?></span>
					</label>
					<label>Public key
						<input type="text" name="public_key" value="<?php echo esc_attr( $s['public_key'] ); ?>" placeholder="pk_live_…" autocomplete="off" />
						<span class="hint"><?php esc_html_e( 'Loaded in the browser. Safe to expose.', 'prynt' ); ?></span>
					</label>
					<label>Secret key
						<input type="password" name="secret_key" value="<?php echo esc_attr( $s['secret_key'] ); ?>" placeholder="sk_live_…" autocomplete="off" />
						<span class="hint"><?php esc_html_e( 'Server-side only, used to verify verdicts. Never sent to the browser.', 'prynt' ); ?></span>
					</label>

					<h2><?php esc_html_e( 'Protection', 'prynt' ); ?></h2>
					<div class="prynt-toggles">
						<label class="cb"><input type="checkbox" name="protect_login" value="1" <?php checked( $s['protect_login'] ); ?> /> <?php esc_html_e( 'Login', 'prynt' ); ?></label>
						<label class="cb"><input type="checkbox" name="protect_register" value="1" <?php checked( $s['protect_register'] ); ?> /> <?php esc_html_e( 'Registration', 'prynt' ); ?></label>
						<label class="cb"><input type="checkbox" name="protect_comments" value="1" <?php checked( $s['protect_comments'] ); ?> /> <?php esc_html_e( 'Comments', 'prynt' ); ?></label>
						<label class="cb"><input type="checkbox" name="protect_woocommerce" value="1" <?php checked( $s['protect_woocommerce'] ); ?> /> <?php esc_html_e( 'WooCommerce checkout', 'prynt' ); ?></label>
					</div>
					<p style="margin-top:10px">
						<label><?php esc_html_e( 'Expected form language scripts', 'prynt' ); ?>
							<input type="text" name="expected_scripts" value="<?php echo esc_attr( isset( $s['expected_scripts'] ) ? $s['expected_scripts'] : 'latin' ); ?>" placeholder="latin" style="width:180px" />
						</label>
						<br /><span class="description"><?php esc_html_e( 'Comma-separated (e.g. "latin"). Flags Cyrillic/CJK spam in forms that expect these scripts. Leave blank for multilingual sites.', 'prynt' ); ?></span>
					</p>

					<h2><?php esc_html_e( 'Action', 'prynt' ); ?></h2>
					<label class="radio"><input type="radio" name="mode" value="monitor" <?php checked( $s['mode'], 'monitor' ); ?> /> <?php esc_html_e( 'Monitor only — log verdicts, block nothing', 'prynt' ); ?></label>
					<label class="radio"><input type="radio" name="mode" value="block" <?php checked( $s['mode'], 'block' ); ?> /> <?php esc_html_e( 'Block — deny high-risk / bot submissions', 'prynt' ); ?></label>
					<label>Block at risk score ≥
						<input type="number" name="block_score" min="1" max="100" value="<?php echo esc_attr( $s['block_score'] ); ?>" class="small" />
						<span class="hint"><?php esc_html_e( 'Only applies in Block mode. Bots and block-verdicts are always denied.', 'prynt' ); ?></span>
					</label>

					<p><button type="submit" class="button button-primary button-hero"><?php esc_html_e( 'Save settings', 'prynt' ); ?></button></p>
				</form>

				<div>
				<?php Prynt_Reveal::render_card(); ?>
				<div class="prynt-card">
					<h2><?php esc_html_e( 'Recent activity', 'prynt' ); ?></h2>
					<?php if ( empty( $recent ) ) : ?>
						<p class="hint"><?php esc_html_e( 'No protected submissions yet. Verdicts will appear here.', 'prynt' ); ?></p>
					<?php else : ?>
						<table class="prynt-log">
							<thead><tr><th><?php esc_html_e( 'When', 'prynt' ); ?></th><th><?php esc_html_e( 'Form', 'prynt' ); ?></th><th><?php esc_html_e( 'Verdict', 'prynt' ); ?></th><th><?php esc_html_e( 'Risk', 'prynt' ); ?></th></tr></thead>
							<tbody>
							<?php foreach ( array_slice( $recent, 0, 15 ) as $row ) : ?>
								<tr>
									<td><?php echo esc_html( human_time_diff( (int) $row['time'] ) . ' ' . __( 'ago', 'prynt' ) ); ?></td>
									<td><?php echo esc_html( $row['context'] ); ?></td>
									<td><span class="pill <?php echo ( 'block' === $row['decision'] || ! empty( $row['bot'] ) ) ? 'bad' : ( 'challenge' === $row['decision'] ? 'warn' : 'ok' ); ?>"><?php echo esc_html( ! empty( $row['bot'] ) ? 'bot' : $row['decision'] ); ?></span></td>
									<td><?php echo (int) $row['riskScore']; ?></td>
								</tr>
							<?php endforeach; ?>
							</tbody>
						</table>
					<?php endif; ?>
					<p class="hint"><?php echo wp_kses_post( sprintf( __( 'Full analytics in your <a href="%s" target="_blank" rel="noopener">Prynt console</a>.', 'prynt' ), 'https://app.pryntid.com' ) ); ?></p>
				</div>
				</div>
			</div>
		</div>
		<?php
	}
}
