package dev.dshlink.control;

/** A dsh-link request failure. status 0 means the request never reached an HTTP response. */
final class ApiException extends Exception {
    final int status;
    final String code;

    ApiException(int status, String message, String code) {
        super(message);
        this.status = status;
        this.code = code == null ? "" : code;
    }

    boolean isNetworkError() {
        return status == 0;
    }
}
