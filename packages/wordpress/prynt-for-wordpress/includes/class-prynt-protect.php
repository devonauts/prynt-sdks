<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Loads the Prynt agent on the relevant forms and enforces the verdict server-side on submit.
 */
class Prynt_Protect {

	public function __construct() {
		if ( ! prynt_is_configured() ) {
			return;
		}
		$s = prynt_get_settings();

		// Load the agent on front-end + login page.
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'login_enqueue_scripts', array( $this, 'enqueue' ) );

		// Inject the hidden fields the JS fills, on the forms we protect.
		if ( ! empty( $s['protect_login'] ) ) {
			add_action( 'login_form', array( $this, 'fields' ) );
			add_filter( 'authenticate', array( $this, 'check_login' ), 30, 3 );
		}
		if ( ! empty( $s['protect_register'] ) ) {
			add_action( 'register_form', array( $this, 'fields' ) );
			add_filter( 'registration_errors', array( $this, 'check_register' ), 10, 3 );
		}
		if ( ! empty( $s['protect_comments'] ) ) {
			add_action( 'comment_form', array( $this, 'fields' ) );
			add_filter( 'preprocess_comment', array( $this, 'check_comment' ) );
		}
		if ( ! empty( $s['protect_woocommerce'] ) ) {
			add_action( 'woocommerce_review_order_before_submit', array( $this, 'fields' ) );
			add_action( 'woocommerce_checkout_process', array( $this, 'check_woocommerce' ) );
		}
	}

	public function enqueue() {
		$s = prynt_get_settings();
		wp_enqueue_script( 'prynt-agent', trailingslashit( $s['endpoint'] ) . 'cdn/prynt.umd.js', array(), PRYNT_VERSION, true );
		wp_enqueue_script( 'prynt-front', PRYNT_URL . 'assets/prynt.js', array( 'prynt-agent' ), PRYNT_VERSION, true );
		$scripts = array_values( array_filter( array_map( 'trim', explode( ',', isset( $s['expected_scripts'] ) ? $s['expected_scripts'] : 'latin' ) ) ) );
		wp_localize_script( 'prynt-front', 'PryntWP', array(
			'endpoint'        => esc_url_raw( $s['endpoint'] ),
			'publicKey'       => $s['public_key'],
			'expectedScripts' => $scripts,
		) );
	}

	/** Hidden inputs the agent fills with the requestId of the live identification. */
	public function fields() {
		echo '<input type="hidden" name="prynt_request_id" class="prynt-request-id" value="" />';
	}

	private function request_id() {
		return isset( $_POST['prynt_request_id'] ) ? sanitize_text_field( wp_unslash( $_POST['prynt_request_id'] ) ) : '';
	}

	/** Login: return a WP_Error to deny. */
	public function check_login( $user, $username, $password ) {
		if ( empty( $username ) ) { // first render, nothing submitted
			return $user;
		}
		$v = Prynt_Client::verify( $this->request_id() );
		Prynt_Client::log( 'login', $v );
		if ( Prynt_Client::should_block( $v ) ) {
			return new WP_Error( 'prynt_blocked', __( '<strong>Blocked:</strong> this sign-in was flagged as high-risk.', 'prynt' ) );
		}
		return $user;
	}

	/** Registration: add an error to deny. */
	public function check_register( $errors, $login, $email ) {
		$v = Prynt_Client::verify( $this->request_id() );
		Prynt_Client::log( 'register', $v );
		if ( Prynt_Client::should_block( $v ) ) {
			$errors->add( 'prynt_blocked', __( '<strong>Blocked:</strong> registration was flagged as high-risk.', 'prynt' ) );
		}
		return $errors;
	}

	/** Comments: die (or you could mark spam) to deny. */
	public function check_comment( $commentdata ) {
		$v = Prynt_Client::verify( $this->request_id() );
		Prynt_Client::log( 'comment', $v );
		if ( Prynt_Client::should_block( $v ) ) {
			wp_die( esc_html__( 'Your comment was flagged as high-risk and blocked.', 'prynt' ), 403 );
		}
		return $commentdata;
	}

	/** WooCommerce checkout: add a notice to stop the order. */
	public function check_woocommerce() {
		$v = Prynt_Client::verify( $this->request_id() );
		Prynt_Client::log( 'woocommerce', $v );
		if ( Prynt_Client::should_block( $v ) && function_exists( 'wc_add_notice' ) ) {
			wc_add_notice( __( 'This order was flagged as high-risk. Please contact support.', 'prynt' ), 'error' );
		}
	}
}
