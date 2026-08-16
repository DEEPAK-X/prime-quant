from __future__ import annotations

import unittest
from types import SimpleNamespace

from rlm import ast_linter
from rlm.ast_linter import LookaheadBiasError, Violation


def rules(source: str) -> set[str]:
    return {violation.rule for violation in ast_linter.lint(source)}


class FutureShiftTest(unittest.TestCase):
    def test_negative_shift_positional(self) -> None:
        self.assertIn("future-shift", rules('df["signal"].shift(-1)'))

    def test_negative_shift_keyword(self) -> None:
        self.assertIn("future-shift", rules("df.close.shift(periods=-2)"))

    def test_negative_shift_on_returns(self) -> None:
        self.assertIn("future-shift", rules("returns.shift(-1)"))

    def test_clean_positive_shift(self) -> None:
        self.assertEqual(rules('df["signal"].shift(1)'), set())

    def test_clean_bare_shift(self) -> None:
        self.assertEqual(rules("df.close.shift()"), set())

    def test_clean_positive_keyword(self) -> None:
        self.assertEqual(rules("df.close.shift(periods=5)"), set())


class FutureIndexTest(unittest.TestCase):
    def test_iloc_future_index(self) -> None:
        self.assertIn("future-index", rules("df.iloc[t + 1]"))

    def test_loc_future_index(self) -> None:
        self.assertIn("future-index", rules("data.loc[t + 1]"))

    def test_subscript_future_index(self) -> None:
        self.assertIn("future-index", rules("close[t + 1]"))

    def test_loop_future_index(self) -> None:
        self.assertIn("future-index", rules("for i in range(n):\n    x = close[i + 3]"))

    def test_slice_future_stop(self) -> None:
        self.assertIn("future-index", rules("window = close[: t + 1]"))

    def test_slice_future_start(self) -> None:
        self.assertIn("future-index", rules("window = close[t + 1 :]"))

    def test_clean_current_index(self) -> None:
        self.assertEqual(rules("x = close[t]"), set())

    def test_clean_past_index(self) -> None:
        self.assertEqual(rules("x = df.iloc[t - 1]"), set())

    def test_clean_zero_offset(self) -> None:
        self.assertEqual(rules("x = close[t + 0]"), set())


class SignalLagTest(unittest.TestCase):
    def test_signal_times_returns(self) -> None:
        self.assertIn("signal-lag", rules("strategy = signal * ret"))

    def test_position_times_pct_change(self) -> None:
        self.assertIn("signal-lag", rules("pnl = position * close.pct_change()"))

    def test_nested_mult(self) -> None:
        self.assertIn("signal-lag", rules("sharpe = (signal * returns).mean()"))

    def test_augmented_mult(self) -> None:
        self.assertIn("signal-lag", rules("pnl *= signal"))

    def test_clean_shifted_signal(self) -> None:
        self.assertEqual(rules("strategy = signal.shift(1) * ret"), set())

    def test_clean_assigned_shifted_signal(self) -> None:
        source = "executed = signal.shift(1)\nstrategy = executed * ret"
        self.assertEqual(rules(source), set())

    def test_clean_lagged_returns(self) -> None:
        self.assertEqual(rules("strategy = signal * ret.shift(1)"), set())

    def test_clean_lagged_name(self) -> None:
        self.assertEqual(rules("strategy = signal_lag1 * ret"), set())


class GlobalNormalizationTest(unittest.TestCase):
    def test_zscore_full_dataset(self) -> None:
        self.assertIn("global-normalization", rules("z = (df - df.mean()) / df.std()"))

    def test_zscore_flipped_sign(self) -> None:
        self.assertIn("global-normalization", rules("z = (df.mean() - df) / df.std()"))

    def test_zscore_in_expression(self) -> None:
        self.assertIn("global-normalization", rules("df_z = (df - df.mean()) / df.std() + 1"))

    def test_clean_rolling_window(self) -> None:
        source = "z = (df - df.rolling(252).mean()) / df.rolling(252).std()"
        self.assertEqual(rules(source), set())

    def test_clean_expanding_window(self) -> None:
        source = "z = (df - df.expanding().mean()) / df.expanding().std()"
        self.assertEqual(rules(source), set())


class SplitLeakageTest(unittest.TestCase):
    def test_scaler_fit_before_split(self) -> None:
        source = "scaler.fit(df)\nX_train, X_test = train_test_split(df)"
        self.assertIn("split-leakage", rules(source))

    def test_fit_transform_full_data(self) -> None:
        source = "X_scaled = StandardScaler().fit_transform(X)\nX_train, X_test = train_test_split(X_scaled)"
        self.assertIn("split-leakage", rules(source))

    def test_normalization_before_split(self) -> None:
        source = "Xz = (X - X.mean()) / X.std()\nX_train, X_test = train_test_split(Xz)"
        self.assertIn("split-leakage", rules(source))

    def test_split_on_scaled_expression(self) -> None:
        source = "X_train, X_test = train_test_split(scale(X), test_size=0.2)"
        self.assertIn("split-leakage", rules(source))

    def test_clean_fit_on_train_only(self) -> None:
        source = (
            "X_train, X_test = train_test_split(X, test_size=0.2)\n"
            "scaler.fit(X_train)\n"
            "X_train_s = scaler.transform(X_train)\n"
            "X_test_s = scaler.transform(X_test)"
        )
        self.assertEqual(rules(source), set())

    def test_clean_no_split_in_cell(self) -> None:
        # No split in this cell, so a scaler fit cannot be tied to a leak here.
        source = "scaler = StandardScaler()\nscaler.fit(df)"
        self.assertEqual(rules(source), set())


class CellFilteringTest(unittest.TestCase):
    def test_magic_cells_skipped(self) -> None:
        self.assertEqual(rules("%time x = 1"), set())
        self.assertEqual(rules("!ls -la"), set())
        self.assertEqual(rules("?df"), set())

    def test_skip_marker(self) -> None:
        source = "# prime-quant: skip-lint\nstrategy = signal * ret"
        self.assertEqual(rules(source), set())

    def test_syntax_error_silent(self) -> None:
        self.assertEqual(rules("def broken(:"), set())

    def test_clean_generic_code(self) -> None:
        source = "total = sum(x * y for x, y in zip(a, b))\nprint(total)"
        self.assertEqual(rules(source), set())

    def test_clean_dataframe_ops(self) -> None:
        source = (
            "import pandas as pd\n"
            "df = pd.read_csv(\"prices.csv\")\n"
            "df[\"signal\"] = df.close > df.close.rolling(20).mean()\n"
            "df[\"executed\"] = df.signal.shift(1)\n"
            "df[\"pnl\"] = df.executed * df.close.pct_change()"
        )
        self.assertEqual(rules(source), set())


class PublicApiTest(unittest.TestCase):
    def test_violation_shape(self) -> None:
        violations = ast_linter.lint("signal * ret")
        self.assertEqual(len(violations), 1)
        violation = violations[0]
        self.assertIsInstance(violation, Violation)
        self.assertEqual(violation.rule, "signal-lag")
        self.assertGreaterEqual(violation.line, 1)

    def test_check_alias(self) -> None:
        self.assertEqual(ast_linter.check("signal * ret"), ast_linter.lint("signal * ret"))

    def test_format_violations(self) -> None:
        message = ast_linter.format_violations(ast_linter.lint("signal * ret"))
        self.assertIn("signal-lag", message)
        self.assertIn("skip-lint", message)

    def test_assert_clean_raises(self) -> None:
        with self.assertRaises(LookaheadBiasError):
            ast_linter.assert_clean("df.iloc[t + 1]")

    def test_assert_clean_passes(self) -> None:
        ast_linter.assert_clean("x = df.iloc[t - 1]")


class GuardInstallTest(unittest.TestCase):
    def setUp(self) -> None:
        # The module guard is a process-global singleton; force re-install so the
        # fake shell receives the transform and the enabled flag is deterministic.
        ast_linter._installed = False
        ast_linter._enabled = True

    def _guarded_shell(self) -> SimpleNamespace:
        manager = SimpleNamespace(line_transforms=[])
        return SimpleNamespace(input_transformer_manager=manager)

    def _transform(self, shell: SimpleNamespace):
        self.assertEqual(len(shell.input_transformer_manager.line_transforms), 1)
        return shell.input_transformer_manager.line_transforms[0]

    def test_install_blocks_biased_cell(self) -> None:
        shell = self._guarded_shell()
        self.assertTrue(ast_linter.install(shell))
        with self.assertRaises(LookaheadBiasError):
            self._transform(shell)(["strategy = signal * ret\n"])

    def test_install_passes_clean_cell(self) -> None:
        shell = self._guarded_shell()
        ast_linter.install(shell)
        lines = ["x = 1\n"]
        self.assertEqual(self._transform(shell)(lines), lines)

    def test_install_skips_magic_cell(self) -> None:
        shell = self._guarded_shell()
        ast_linter.install(shell)
        lines = ["!ls\n"]
        self.assertEqual(self._transform(shell)(lines), lines)

    def test_transform_flagged_has_side_effects(self) -> None:
        # check_complete() skips transforms flagged has_side_effects so the TUI's
        # incremental multi-line input detection never lints half-typed cells.
        shell = self._guarded_shell()
        ast_linter.install(shell)
        self.assertTrue(getattr(self._transform(shell), "has_side_effects", False))

    def test_disable_suppresses_guard(self) -> None:
        shell = self._guarded_shell()
        ast_linter.install(shell)
        ast_linter.disable()
        try:
            lines = ["strategy = signal * ret\n"]
            self.assertEqual(self._transform(shell)(lines), lines)
        finally:
            ast_linter.enable()

    def test_install_idempotent(self) -> None:
        shell = self._guarded_shell()
        ast_linter.install(shell)
        ast_linter.install(shell)
        self.assertEqual(len(shell.input_transformer_manager.line_transforms), 1)


if __name__ == "__main__":
    unittest.main()
