from pathlib import Path


def test_ptt_tracks_actual_key_state_release_not_a_timer():
    assert (Path(__file__).parents[1] / 'hotkey.py').is_file(), 'Hold/release observer not implemented'
    from hotkey import HoldObserver
    observer = HoldObserver()
    assert observer.update(False, True) is None  # do not arm on a chord held before enable
    assert observer.update(True, True) is None
    assert observer.update(True, False) is None
    assert observer.update(True, True) == 'start'
    assert observer.update(True, True) is None  # autorepeat is not another recording
    assert observer.update(True, False) == 'release'
    assert observer.update(True, False) is None
    assert observer.update(True, True) == 'start'
    assert observer.update(False, True) == 'cancel'


def test_approval_observes_physical_edges_not_voice_or_repeated_registration_callback():
    source = (Path(__file__).parents[1] / 'hotkey.py').read_text()
    assert "approval_observer.update(approval_id(), approval_allowed(), approval_chord)" in source
    assert "emit({'type': 'approval-hotkey', 'id': card})" in source
    server = (Path(__file__).parents[1] / 'server.py').read_text()
    assert "self.approval_hotkey = data.get('enabled') is True" in server


def test_approval_gesture_is_bound_to_displayed_card_and_requires_release_on_card_change():
    from hotkey import ApprovalObserver
    observer = ApprovalObserver()
    assert observer.update(None, True, False) is None
    assert observer.update('first', True, True) is None  # pressed before card display
    assert observer.update('first', True, False) is None
    assert observer.update('first', True, True) == 'first'
    assert observer.update('first', True, True) is None
    assert observer.update('second', True, True) is None  # held across new request
    assert observer.update('second', True, False) is None
    assert observer.update('second', True, True) == 'second'
    assert observer.update('third', False, False) is None  # registration failed
    assert observer.update('third', False, True) is None
