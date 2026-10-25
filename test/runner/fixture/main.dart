// Fixture app for the macOS runner E2E (test/runner/runner.e2e.test.mjs).
// A full-screen color that flips between two very different colors on every
// tap, so the test can prove a browser tap reached the real iOS Simulator.
import 'package:flutter/material.dart';

void main() => runApp(const FixtureApp());

class FixtureApp extends StatefulWidget {
  const FixtureApp({super.key});
  @override
  State<FixtureApp> createState() => _FixtureAppState();
}

class _FixtureAppState extends State<FixtureApp> {
  int taps = 0;

  @override
  Widget build(BuildContext context) {
    final dark = taps.isEven;
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => taps++),
        child: Container(
          color: dark ? const Color(0xFF1B5E20) : const Color(0xFFFFEB3B),
          alignment: Alignment.center,
          child: Text(
            'taps: $taps',
            textDirection: TextDirection.ltr,
            style: TextStyle(fontSize: 48, color: dark ? Colors.white : Colors.black),
          ),
        ),
      ),
    );
  }
}
