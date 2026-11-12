# Shared by the fake rescue-server commands (lsblk, dumpe2fs, mount, findmnt). MOCK_DISK picks the scenario.
ROOT_UUID=ed286e63-e359-410b-a66f-f67027427e04
OTHER_UUID=0a1b2c3d-1111-2222-3333-444455556666
scn=${MOCK_DISK:-good}
root_label=""
[[ $scn == good_label ]] && root_label=cloudimg-rootfs
# lsblk rows: NAME TYPE FSTYPE LABEL UUID PARTTYPE
rows() {
    echo "/dev/sda disk '' '' '' ''"
    echo "/dev/sda1 part ext4 '$root_label' $ROOT_UUID 0fc63daf-8483-4772-8e79-3d69d8477de4"
    [[ $scn == no_bios ]] || echo "/dev/sda14 part '' '' '' 21686148-6449-6e6f-744e-656564454649"
    echo "/dev/sda15 part vfat '' E657-F13D c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
    case $scn in
        good_boot|boot_needs_recovery) echo "/dev/sda13 part ext4 BOOT $OTHER_UUID 0fc63daf-8483-4772-8e79-3d69d8477de4" ;;
        second_root) echo "/dev/sda2 part ext4 cloudimg-rootfs $OTHER_UUID 0fc63daf-8483-4772-8e79-3d69d8477de4" ;;
        extra_partition) echo "/dev/sda2 part ext4 DECOY $OTHER_UUID 0fc63daf-8483-4772-8e79-3d69d8477de4" ;;
        extra_xfs) echo "/dev/sda2 part xfs '' $OTHER_UUID 0fc63daf-8483-4772-8e79-3d69d8477de4" ;;
        second_esp) echo "/dev/sda2 part vfat '' ABCD-1234 c12a7328-f81f-11d2-ba4b-00a0c93ec93b" ;;
    esac
}
